// Batch runner: node cli.js [--products P001,P005] [--markets amazon_de,cdiscount_fr] [--audiences professional,student] [--concurrency 4]
// Writes output/listings.json and output/listings.csv and prints the business-impact summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, readJson } from './src/util.js';
import { generateListing } from './src/pipeline.js';
import { computeRoi } from './src/roi.js';
import { getMode, getModel } from './src/claude.js';
import { initStore, recordGeneration } from './src/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, '.env'));
initStore(path.join(root, 'data', 'store'));
const data = (f) => readJson(path.join(root, 'data', f));
const brand = data('brand.json');
const categoryRules = data('category_rules.json');
const assumptions = data('assumptions.json');

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const pick = (list, ids) => (ids ? list.filter((x) => ids.split(',').includes(x.id)) : list);
const products = pick(data('products.json'), args.products);
const markets = pick(data('markets.json'), args.markets);
const audiences = pick(data('audiences.json'), args.audiences || 'general');
const limit = Number(args.concurrency) || 4;

console.log(`Mode: ${getMode()}${getMode() === 'live' ? ` (${getModel()})` : ' (offline mock; set ANTHROPIC_API_KEY)'}`);
const jobs = products.flatMap((p) => markets.flatMap((m) => audiences.map((a) => ({ p, m, a }))));
const results = [];
let next = 0;
const started = Date.now();

await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
  while (next < jobs.length) {
    const { p, m, a } = jobs[next++];
    try {
      const r = await generateListing(p, m, { brand, categoryRules }, a);
      recordGeneration(p.id, m.id, a, p, m, r);
      results.push(r);
      console.log(`${r.status.padEnd(12)} ${p.id} x ${m.id} x ${a.id}  attempts=${r.attempts}  ${(r.elapsedMs / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error(`FAILED       ${p.id} x ${m.id} x ${a.id}: ${err.message}`);
    }
  }
}));

const out = path.join(root, 'output');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'listings.json'), JSON.stringify(results, null, 2));
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const csv = [
  'product_id,market,audience,status,title,bullets,description,legal_notice,seo_keywords',
  ...results.map((r) => [r.productId, r.marketId, r.audienceId, r.status, r.listing.title, r.listing.bullets.join(' | '), r.listing.description, r.listing.legal_notice, r.listing.seo_keywords.join(', ')].map(q).join(','))
].join('\n');
fs.writeFileSync(path.join(out, 'listings.csv'), csv);

console.log(`\nWall-clock: ${((Date.now() - started) / 1000).toFixed(1)}s for ${results.length} listings. Output in ./output`);
console.log(JSON.stringify(computeRoi(results, assumptions), null, 2));
