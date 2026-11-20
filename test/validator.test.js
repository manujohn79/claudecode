import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from '../src/util.js';
import { validate, hasErrors } from '../src/validator.js';
import { computeRoi } from '../src/roi.js';

const d = (f) => readJson(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', f));
const markets = Object.fromEntries(d('markets.json').map((m) => [m.id, m]));
const products = Object.fromEntries(d('products.json').map((p) => [p.id, p]));
const rules = d('category_rules.json');

const good = {
  title: 'AuraBuds Pro wireless earbuds with active noise cancelling, black',
  bullets: ['Up to 32 h total battery life with the charging case', 'Active noise cancelling in 3 modes', 'IPX5 water resistant for workouts', 'Bluetooth 5.3 for a stable connection', 'Three ear tip sizes included for a secure fit'],
  description: 'AuraBuds Pro combine active noise cancelling with long battery life. Listen for 8 hours on a single charge and up to 32 hours with the charging case. IPX5 water resistance makes them suitable for workouts.',
  attributes: { colour: 'Midnight black', connectivity: 'Bluetooth 5.3', battery_life: '8 h earbuds, 32 h with case' },
  seo_keywords: ['wireless earbuds', 'noise cancelling earbuds', 'bluetooth earbuds'],
  image_alt_text: 'Black AuraBuds Pro earbuds next to their charging case',
  legal_notice: '',
  claims_removed: []
};

test('clean listing passes', () => {
  assert.equal(hasErrors(validate(good, markets.amazon_us, products.P001, rules)), false);
});

test('flags banned marketing terms and title characters', () => {
  const bad = { ...good, title: 'BEST EARBUDS IN THE WORLD!!! Free shipping' };
  const codes = validate(bad, markets.amazon_us, products.P001, rules).map((v) => v.code);
  assert.ok(codes.includes('BANNED_TERM'));
  assert.ok(codes.includes('TITLE_CHARS'));
});

test('flags medical claims unless approved, in the right language', () => {
  const bad = { ...good, description: good.description + ' Heilt Hautreizungen schnell.' };
  assert.ok(validate(bad, markets.amazon_de, products.P003, rules).some((v) => v.code === 'MEDICAL_CLAIM'));
});

test('flags imperial units in metric markets only', () => {
  const l = { ...good, bullets: [...good.bullets.slice(0, 4), 'Height 10 inches'] };
  assert.ok(validate(l, markets.amazon_de, products.P001, rules).some((v) => v.code === 'UNITS'));
  assert.ok(!validate(l, markets.amazon_us, products.P001, rules).some((v) => v.code === 'UNITS'));
});

test('requires legal notice for toys and cosmetics', () => {
  const v = validate({ ...good, attributes: { age_range: '4+', piece_count: '120' } }, markets.amazon_us, products.P006, rules);
  assert.ok(v.some((x) => x.code === 'LEGAL_MISSING'));
});

test('enforces length limits', () => {
  const v = validate({ ...good, title: 'x'.repeat(200) }, markets.amazon_us, products.P001, rules);
  assert.ok(v.some((x) => x.code === 'TITLE_LENGTH'));
});

test('ROI: automation is cheaper than the manual baseline', () => {
  const r = { mode: 'live', status: 'approved', usage: { input: 1500, output: 700, cacheWrite: 0, cacheRead: 1000 }, elapsedMs: 9000, history: [{ attempt: 1, errors: 0 }], violations: [] };
  const roi = computeRoi([r, { ...r, status: 'needs_review' }], d('assumptions.json'));
  assert.ok(roi.savings.pct > 50);
  assert.equal(roi.listings, 2);
});
