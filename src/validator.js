// Deterministic compliance gate. Runs on every Claude output; failures are fed back to Claude for repair.

const MEDICAL_TERMS = {
  en: ['cure', 'cures', 'heal', 'heals', 'treat', 'treats', 'clinically proven', 'dermatologist approved', 'prevents disease', 'boosts immunity', 'burns fat'],
  de: ['heilt', 'heilung', 'behandelt', 'klinisch bewiesen', 'dermatologisch getestet und bewiesen', 'stärkt das immunsystem', 'verbrennt fett'],
  fr: ['guérit', 'guérison', 'cliniquement prouvé', 'soigne', 'booste l\'immunité', 'brûle les graisses'],
  es: ['cura', 'cura el', 'curación', 'clínicamente probado', 'sana', 'refuerza el sistema inmunitario', 'quema grasa'],
  ja: ['治る', '治療', '治癒', '臨床的に証明', '免疫力を高める', '脂肪を燃焼']
};

const IMPERIAL = /(\b(oz|fl\.?\s?oz|inch(es)?|lbs?|pounds?|ft|feet|gallons?)\b|°\s?F\b)/i;
const TITLE_BAD_CHARS = /[!$?{}^¬¦]/;
const letters = (s) => s.replace(/[^\p{L}]/gu, '');

function termRegex(term) {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
}

function allText(listing) {
  return [
    ['title', listing.title],
    ...(listing.bullets || []).map((b, i) => [`bullets[${i + 1}]`, b]),
    ['description', listing.description],
    ['image_alt_text', listing.image_alt_text],
    ['legal_notice', listing.legal_notice],
    ...Object.entries(listing.attributes || {}).map(([k, v]) => [`attributes.${k}`, String(v)]),
    ['seo_keywords', (listing.seo_keywords || []).join(' ; ')]
  ].filter(([, v]) => typeof v === 'string' && v.length);
}

export function validate(listing, market, product, categoryRules) {
  const v = [];
  const err = (code, field, message) => v.push({ severity: 'error', code, field, message });
  const warn = (code, field, message) => v.push({ severity: 'warn', code, field, message });
  const rules = categoryRules[product.category] || {};

  const title = (listing.title || '').trim();
  if (!title) err('TITLE_MISSING', 'title', 'Title is empty.');
  if (title.length > market.title_max) err('TITLE_LENGTH', 'title', `Title is ${title.length} characters; maximum is ${market.title_max}.`);
  if (TITLE_BAD_CHARS.test(title)) err('TITLE_CHARS', 'title', 'Title contains characters not allowed by the channel (! $ ? { } ^).');
  const tl = letters(title);
  if (tl.length > 6 && tl === tl.toUpperCase() && tl !== tl.toLowerCase()) warn('TITLE_CAPS', 'title', 'Title is written in ALL CAPS.');

  const bullets = listing.bullets || [];
  if (bullets.length !== market.bullet_count) err('BULLET_COUNT', 'bullets', `Expected exactly ${market.bullet_count} bullets, got ${bullets.length}.`);
  bullets.forEach((b, i) => {
    if (b.length > market.bullet_max) err('BULLET_LENGTH', `bullets[${i + 1}]`, `Bullet is ${b.length} characters; maximum is ${market.bullet_max}.`);
  });

  const d = listing.description || '';
  if (d.length < market.description_min) err('DESC_SHORT', 'description', `Description is ${d.length} characters; minimum is ${market.description_min}.`);
  if (d.length > market.description_max) err('DESC_LONG', 'description', `Description is ${d.length} characters; maximum is ${market.description_max}.`);
  if (/<[a-z][\s\S]*>/i.test(d)) err('DESC_HTML', 'description', 'Description contains HTML.');

  if (!listing.image_alt_text) err('ALT_MISSING', 'image_alt_text', 'Image alt text is missing.');
  else if (listing.image_alt_text.length > 125) err('ALT_LENGTH', 'image_alt_text', `Alt text is ${listing.image_alt_text.length} characters; maximum is 125.`);

  const kw = listing.seo_keywords || [];
  if (kw.length < 3) warn('SEO_FEW', 'seo_keywords', 'Fewer than 3 SEO keywords.');

  for (const key of rules.required_attributes || []) {
    if (!listing.attributes || !String(listing.attributes[key] || '').trim()) err('ATTR_MISSING', `attributes.${key}`, `Required attribute "${key}" is missing.`);
  }
  if (rules.legal_notice_required && !String(listing.legal_notice || '').trim()) {
    err('LEGAL_MISSING', 'legal_notice', `Category "${product.category}" requires a legal/safety notice.`);
  }

  const banned = market.banned_terms.map((t) => [t, termRegex(t)]);
  const medical = (MEDICAL_TERMS[market.lang] || MEDICAL_TERMS.en).map((t) => [t, termRegex(t)]);
  const approved = (product.approved_claims || []).join(' ').toLowerCase();
  for (const [field, text] of allText(listing)) {
    if (field === 'seo_keywords') continue;
    for (const [term, re] of banned) if (re.test(text)) err('BANNED_TERM', field, `Contains prohibited term "${term}".`);
    for (const [term, re] of medical) if (re.test(text) && !approved.includes(term)) err('MEDICAL_CLAIM', field, `Contains medical/health claim "${term}" that is not an approved claim.`);
    if (market.units === 'metric' && IMPERIAL.test(text)) err('UNITS', field, 'Contains imperial units in a metric market.');
  }

  return v;
}

export const hasErrors = (violations) => violations.some((x) => x.severity === 'error');
