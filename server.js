import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readJson } from './src/util.js';
import { generateListing, THRESHOLDS } from './src/pipeline.js';
import { computeRoi } from './src/roi.js';
import { getMode, getModel } from './src/claude.js';
import { validate } from './src/validator.js';
import { initStore, keyOf, recordGeneration, getListing, listAll, stats, recordDecision, productHash, applyOverride, setOverride } from './src/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));
initStore(path.join(root, 'data', 'store'));

const data = (f) => readJson(path.join(root, 'data', f));
const brand = data('brand.json');
const markets = data('markets.json');
const categoryRules = data('category_rules.json');
const assumptions = data('assumptions.json');
const audiences = data('audiences.json');
const audienceFor = (id) => audiences.find((a) => a.id === id) || audiences[0];

// Each catalogue product may have a default photo at data/images/<id>.(jpg|png|webp), read once at
// startup and base64-encoded in memory. Entirely optional: a product with no file just has no image.
const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
function loadDefaultImage(productId) {
  for (const [ext, media_type] of Object.entries(IMAGE_EXT)) {
    const file = path.join(root, 'data', 'images', `${productId}${ext}`);
    if (fs.existsSync(file)) return { media_type, data: fs.readFileSync(file).toString('base64') };
  }
  return null;
}
const products = data('products.json').map((p) => {
  const image = loadDefaultImage(p.id);
  return image ? { ...p, image } : p;
});

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
    // Each custom product keeps the id the browser assigned it (U1, U2, ...) so the store
    // can tell distinct custom products apart instead of overwriting one another.
    id: /^[A-Za-z0-9_-]{1,40}$/.test(p.id || '') ? p.id : 'CUSTOM',
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
  // Connect / disconnect Claude from the UI. The key lives only in this process's memory: never written to disk, logged or returned.
  if (url.pathname === '/api/key') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin request blocked' });
    if (req.method === 'DELETE') {
      delete process.env.ANTHROPIC_API_KEY;
      return json(res, 200, { mode: getMode(), model: null });
    }
    if (req.method === 'POST') {
      const { key } = await readBody(req);
      if (typeof key !== 'string' || !/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key.trim())) return json(res, 400, { error: 'That does not look like an Anthropic API key (sk-ant-...)' });
      let check;
      try {
        check = await fetch('https://api.anthropic.com/v1/models?limit=1', {
          headers: { 'x-api-key': key.trim(), 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(15_000)
        });
      } catch {
        return json(res, 502, { error: 'Could not reach api.anthropic.com to verify the key (network or proxy/certificate issue)' });
      }
      if (check.status === 401 || check.status === 403) return json(res, 401, { error: 'Anthropic rejected this key' });
      if (!check.ok) return json(res, 502, { error: `Key check failed (HTTP ${check.status})` });
      process.env.ANTHROPIC_API_KEY = key.trim();
      return json(res, 200, { mode: getMode(), model: getModel() });
    }
    return json(res, 405, { error: 'Method not allowed' });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { mode: getMode(), model: getMode() === 'live' ? getModel() : null, products: products.map(applyOverride), markets, audiences, categories: Object.keys(categoryRules), assumptions, thresholds: THRESHOLDS });
  }
  if (req.method === 'POST' && url.pathname === '/api/products/update') {
    const body = await readBody(req);
    const catalogProduct = products.find((p) => p.id === body.productId);
    if (!catalogProduct) return json(res, 404, { error: 'Unknown catalogue product' });
    const patch = sanitiseProductPatch(body.patch);
    setOverride(body.productId, patch);
    return json(res, 200, { product: applyOverride(catalogProduct) });
  }
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const body = await readBody(req, MAX_IMAGE_BODY);
    const market = markets.find((m) => m.id === body.marketId);
    if (!market) return json(res, 400, { error: 'Unknown market' });
    const catalogProduct = products.find((p) => p.id === body.productId);
    const base = body.product ? sanitiseProduct(body.product) : (catalogProduct ? applyOverride(catalogProduct) : null);
    if (!base) return json(res, 400, { error: 'Unknown product' });
    const image = sanitiseImage(body.image);
    const product = image ? { ...base, image } : base;
    const audience = audienceFor(body.audienceId);
    if (inflight >= MAX_INFLIGHT) return json(res, 429, { error: 'Too many concurrent requests' });
    inflight++;
    let result;
    try {
      result = await generateListing(product, market, { brand, categoryRules }, audience);
    } finally {
      inflight--;
    }
    recordGeneration(product.id, market.id, audience, product, market, result);
    return json(res, 200, result);
  }
  if (req.method === 'POST' && url.pathname === '/api/roi') {
    const body = await readBody(req);
    const results = (Array.isArray(body.results) ? body.results : []).slice(0, 5000).filter((r) => r?.usage && Array.isArray(r.history) && Array.isArray(r.violations));
    return json(res, 200, { roi: computeRoi(results, assumptions) });
  }
  if (req.method === 'GET' && url.pathname === '/api/review/queue') {
    const status = url.searchParams.get('status') || undefined;
    return json(res, 200, { items: listAll({ status }).map(withStaleFlag), stats: stats() });
  }
  if (req.method === 'GET' && url.pathname === '/api/review/item') {
    const entry = getListing(keyOf(url.searchParams.get('productId'), url.searchParams.get('marketId'), url.searchParams.get('audienceId') || undefined));
    if (!entry) return json(res, 404, { error: 'Not found' });
    return json(res, 200, withStaleFlag(entry));
  }
  if (req.method === 'POST' && url.pathname === '/api/review/regenerate') {
    const body = await readBody(req);
    const catalogProduct = products.find((p) => p.id === body.productId);
    const market = markets.find((m) => m.id === body.marketId);
    if (!catalogProduct || !market) return json(res, 404, { error: 'Not found' });
    const product = applyOverride(catalogProduct);
    const audience = audienceFor(body.audienceId);
    if (inflight >= MAX_INFLIGHT) return json(res, 429, { error: 'Too many concurrent requests' });
    inflight++;
    let result;
    try {
      result = await generateListing(product, market, { brand, categoryRules }, audience);
    } finally {
      inflight--;
    }
    return json(res, 200, withStaleFlag(recordGeneration(product.id, market.id, audience, product, market, result)));
  }
  if (req.method === 'POST' && url.pathname === '/api/review/decision') {
    const body = await readBody(req);
    if (!['approved', 'rejected'].includes(body.decision)) return json(res, 400, { error: 'decision must be "approved" or "rejected"' });
    const entry = getListing(keyOf(body.productId, body.marketId, body.audienceId));
    if (!entry) return json(res, 404, { error: 'Not found' });
    let listing, violations;
    if (body.listing) {
      listing = sanitiseListingEdit(body.listing);
      const market = markets.find((m) => m.id === entry.marketId);
      violations = validate(listing, market, entry.product, categoryRules);
    }
    const updated = recordDecision(keyOf(body.productId, body.marketId, body.audienceId), {
      decision: body.decision,
      listing,
      violations,
      reviewer: body.reviewer,
      note: body.note
    });
    return json(res, 200, updated);
  }
  return json(res, 404, { error: 'Not found' });
}

// A listing is stale when the catalogue product it was generated from has since been edited
// (data/products.json is static in this demo; edits live in the override store).
function withStaleFlag(entry) {
  const catalogProduct = products.find((p) => p.id === entry.productId);
  const stale = Boolean(catalogProduct) && productHash(applyOverride(catalogProduct)) !== entry.productHash;
  return { ...entry, stale };
}

// Editing an existing catalogue product (simulates a PIM push): only specs, supplier notes and
// approved claims are editable here; category stays fixed since it drives the rules gate.
function sanitiseProductPatch(p) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  const patch = {};
  if (p?.name != null) patch.name = s(p.name, 120);
  if (p?.brand != null) patch.brand = s(p.brand, 60);
  if (p?.raw_notes != null) patch.raw_notes = s(p.raw_notes, 1500);
  if (Array.isArray(p?.approved_claims)) patch.approved_claims = p.approved_claims.slice(0, 10).map((c) => s(c, 200));
  if (p?.specs && typeof p.specs === 'object') {
    const specs = {};
    for (const [k, v] of Object.entries(p.specs).slice(0, 30)) specs[s(k, 40)] = s(v, 200);
    patch.specs = specs;
  }
  return patch;
}

// A human-edited listing from the review UI: accept only known fields, bounded sizes.
function sanitiseListingEdit(l) {
  const s = (v, n) => String(v ?? '').slice(0, n);
  return {
    title: s(l?.title, 300),
    bullets: (Array.isArray(l?.bullets) ? l.bullets : []).slice(0, 10).map((b) => s(b, 400)),
    description: s(l?.description, 4000),
    attributes: Object.fromEntries(Object.entries(l?.attributes || {}).slice(0, 30).map(([k, v]) => [s(k, 60), s(v, 300)])),
    seo_keywords: (Array.isArray(l?.seo_keywords) ? l.seo_keywords : []).slice(0, 15).map((k) => s(k, 80)),
    image_alt_text: s(l?.image_alt_text, 200),
    legal_notice: s(l?.legal_notice, 1000),
    claims_removed: Array.isArray(l?.claims_removed) ? l.claims_removed.slice(0, 10).map((c) => ({ claim: s(c?.claim, 200), reason: s(c?.reason, 200) })) : []
  };
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
