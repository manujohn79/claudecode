// Durable store for every generated listing and every human review decision.
// Plain JSON + an append-only audit log: zero dependencies, matches this project's scale (pilot/demo,
// not a high-concurrency production system). Writes are synchronous so they can't interleave.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let dbFile, auditFile, overridesFile;
let db = new Map(); // key (productId|marketId) -> current record
let overrides = new Map(); // productId -> edited fields (simulates a PIM update)

export const keyOf = (productId, marketId, audienceId = 'general') => `${productId}|${marketId}|${audienceId}`;

export function initStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  dbFile = path.join(dir, 'listings.json');
  auditFile = path.join(dir, 'audit.jsonl');
  overridesFile = path.join(dir, 'product_overrides.json');
  db = new Map();
  overrides = new Map();
  if (fs.existsSync(dbFile)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(dbFile, 'utf8')))) db.set(k, v);
  }
  if (fs.existsSync(overridesFile)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(overridesFile, 'utf8')))) overrides.set(k, v);
  }
}

function persist() {
  fs.writeFileSync(dbFile, JSON.stringify(Object.fromEntries(db), null, 2));
}

function persistOverrides() {
  fs.writeFileSync(overridesFile, JSON.stringify(Object.fromEntries(overrides), null, 2));
}

// A hash of exactly the fields that feed the prompt (see prompts.js generationUser), so editing
// anything else (sku aside, which is included as it's shown to Claude too) never looks "stale".
export function productHash(product) {
  const { sku, brand, name, category, specs, approved_claims, raw_notes } = product;
  return crypto.createHash('sha1').update(JSON.stringify({ sku, brand, name, category, specs, approved_claims, raw_notes })).digest('hex');
}

// Simulates a PIM/ERP update to a catalogue product: a shallow merge over the static product,
// so editing specs or supplier notes doesn't require touching data/products.json.
export function applyOverride(baseProduct) {
  const o = overrides.get(baseProduct.id);
  return o ? { ...baseProduct, ...o } : baseProduct;
}

export function setOverride(productId, patch) {
  const merged = { ...(overrides.get(productId) || {}), ...patch };
  overrides.set(productId, merged);
  persistOverrides();
  audit({ type: 'product_update', productId });
  return merged;
}

function audit(event) {
  fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

// Drop the (potentially large) image payload before storing a product snapshot; keep only its type.
function snapshotProduct(product) {
  if (!product.image) return product;
  return { ...product, image: { media_type: product.image.media_type } };
}

function withoutVersions(entry) {
  const { versions, ...rest } = entry;
  return rest;
}

// Called after every generation (server UI and CLI batch runs alike). `audience` is the full
// audience record (or null/undefined for the default "general" segment).
export function recordGeneration(productId, marketId, audience, product, market, result) {
  const audienceId = audience?.id || 'general';
  const key = keyOf(productId, marketId, audienceId);
  const prev = db.get(key);
  const entry = {
    key,
    productId,
    marketId,
    audienceId,
    audienceLabel: audience?.label || 'General shopper',
    productName: product.name,
    marketLabel: market.label,
    product: snapshotProduct(product),
    productHash: productHash(product),
    status: result.status, // 'approved' | 'needs_review'
    listing: result.listing,
    violations: result.violations,
    review: result.review,
    attempts: result.attempts,
    history: result.history,
    usage: result.usage,
    elapsedMs: result.elapsedMs,
    mode: result.mode,
    hasImage: result.hasImage,
    generatedAt: new Date().toISOString(),
    human: null,
    versions: prev ? [...(prev.versions || []), withoutVersions(prev)] : []
  };
  db.set(key, entry);
  persist();
  audit({ type: 'generate', key, productId, marketId, audienceId, status: result.status, mode: result.mode });
  return entry;
}

export function getListing(key) {
  return db.get(key) || null;
}

export function listAll({ status } = {}) {
  const all = [...db.values()];
  return status ? all.filter((e) => e.status === status) : all;
}

export function stats() {
  const all = [...db.values()];
  const count = (s) => all.filter((e) => e.status === s).length;
  return {
    total: all.length,
    approved: count('approved'),
    needsReview: count('needs_review'),
    humanApproved: count('human_approved'),
    humanRejected: count('human_rejected')
  };
}

// A human decision on a stored listing: approve or reject, optionally with an edited listing
// and the (re-validated, by the caller) violations for that edited version.
export function recordDecision(key, { decision, listing, violations, reviewer, note }) {
  const entry = db.get(key);
  if (!entry) throw Object.assign(new Error('Unknown listing'), { status: 404 });
  const updated = {
    ...entry,
    versions: [...(entry.versions || []), withoutVersions(entry)],
    listing: listing || entry.listing,
    violations: listing ? violations : entry.violations,
    status: decision === 'approved' ? 'human_approved' : 'human_rejected',
    human: {
      decision,
      edited: Boolean(listing),
      reviewer: String(reviewer || '').slice(0, 80),
      note: String(note || '').slice(0, 500),
      decidedAt: new Date().toISOString()
    }
  };
  db.set(key, updated);
  persist();
  audit({ type: 'review', key, decision, edited: Boolean(listing), reviewer: updated.human.reviewer });
  return updated;
}
