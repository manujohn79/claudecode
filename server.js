import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readJson } from './src/util.js';
import { generateListing } from './src/pipeline.js';
import { computeRoi } from './src/roi.js';
import { getMode, getModel } from './src/claude.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));

const data = (f) => readJson(path.join(root, 'data', f));
const brand = data('brand.json');
const markets = data('markets.json');
const categoryRules = data('category_rules.json');
const assumptions = data('assumptions.json');
const products = data('products.json');

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 100_000;
const MAX_IMAGE_B64 = 1_400_000; // ~1 MB decoded; the UI downsizes images to ~1024px before upload
const MAX_IMAGE_BODY = MAX_IMAGE_B64 + 100_000;
const MAX_INFLIGHT = 8; // simple cost/abuse guard on concurrent Claude work
let inflight = 0;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Custom product from the UI: accept only known fields, bounded sizes, known category.
function sanitiseProduct(p) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  if (!categoryRules[p?.category]) throw Object.assign(new Error('Unknown category'), { status: 400 });
  const specs = {};
  for (const [k, v] of Object.entries(p.specs || {}).slice(0, 30)) specs[s(k, 40)] = s(v, 200);
  return {
    id: 'CUSTOM',
    sku: s(p.sku || 'CUSTOM-001', 40),
    brand: s(p.brand, 60),
    name: s(p.name, 120) || (() => { throw Object.assign(new Error('Product name required'), { status: 400 }); })(),
    category: p.category,
    specs,
    approved_claims: (Array.isArray(p.approved_claims) ? p.approved_claims : []).slice(0, 10).map((c) => s(c, 200)),
    raw_notes: s(p.raw_notes, 1500)
  };
}

// Optional product image: strict media type, bounded size, base64 only, and magic bytes must match the declared type.
const MAGIC = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
};
function sanitiseImage(img) {
  if (img == null) return null;
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  const type = String(img.media_type || '');
  const data = String(img.data || '');
  if (!MAGIC[type]) throw bad('Unsupported image type (use JPEG, PNG, WebP or GIF)');
  if (!data || data.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw bad('Invalid or too large image');
  if (!MAGIC[type](Buffer.from(data.slice(0, 64), 'base64'))) throw bad('Image content does not match its type');
  return { media_type: type, data };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { mode: getMode(), model: getMode() === 'live' ? getModel() : null, products, markets, categories: Object.keys(categoryRules), assumptions });
  }
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const body = await readBody(req, MAX_IMAGE_BODY);
    const market = markets.find((m) => m.id === body.marketId);
    if (!market) return json(res, 400, { error: 'Unknown market' });
    const base = body.product ? sanitiseProduct(body.product) : products.find((p) => p.id === body.productId);
    if (!base) return json(res, 400, { error: 'Unknown product' });
    const image = sanitiseImage(body.image);
    const product = image ? { ...base, image } : base;
    if (inflight >= MAX_INFLIGHT) return json(res, 429, { error: 'Too many concurrent requests' });
    inflight++;
    try {
      return json(res, 200, await generateListing(product, market, { brand, categoryRules }));
    } finally {
      inflight--;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/roi') {
    const body = await readBody(req);
    const results = (Array.isArray(body.results) ? body.results : []).slice(0, 5000).filter((r) => r?.usage && Array.isArray(r.history) && Array.isArray(r.violations));
    return json(res, 200, { roi: computeRoi(results, assumptions) });
  }
  return json(res, 404, { error: 'Not found' });
}

function serveStatic(res, url) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const pub = path.join(root, 'public');
  const file = path.resolve(pub, rel);
  if (!file.startsWith(pub + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(file), { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    json(res, status, { error: status === 500 ? 'Internal error' : err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Catalogue Content AI on http://localhost:${PORT}  (mode: ${getMode()}${getMode() === 'live' ? ', model: ' + getModel() : ' - set ANTHROPIC_API_KEY for real Claude output'})`);
});
