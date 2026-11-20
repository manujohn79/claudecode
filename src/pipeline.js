import { callTool, getMode } from './claude.js';
import { LISTING_TOOL, REVIEW_TOOL, generationSystem, generationUser, reviewSystem, reviewUser } from './prompts.js';
import { validate, hasErrors } from './validator.js';
import { mockGenerate, mockReview } from './mock.js';

const MAX_ATTEMPTS = 3; // 1 generation + up to 2 automatic repairs
export const THRESHOLDS = { faithfulness: 85, compliance: 85, brand: 70, localisation: 70 };

const addUsage = (a, b) => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  cacheRead: a.cacheRead + b.cacheRead
});
const ZERO = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

// Normalise to a safe shape in case the model returns something unexpected.
function normalise(l) {
  const ii = l.image_insights;
  return {
    title: String(l.title ?? ''),
    bullets: Array.isArray(l.bullets) ? l.bullets.map(String) : [],
    description: String(l.description ?? ''),
    attributes: l.attributes && typeof l.attributes === 'object' ? Object.fromEntries(Object.entries(l.attributes).map(([k, v]) => [k, String(v)])) : {},
    seo_keywords: Array.isArray(l.seo_keywords) ? l.seo_keywords.map(String) : [],
    image_alt_text: String(l.image_alt_text ?? ''),
    legal_notice: String(l.legal_notice ?? ''),
    claims_removed: Array.isArray(l.claims_removed) ? l.claims_removed.map((c) => ({ claim: String(c.claim ?? ''), reason: String(c.reason ?? '') })) : [],
    ...(ii && typeof ii === 'object'
      ? {
          image_insights: {
            detected_category: String(ii.detected_category ?? ''),
            matches_category: ii.matches_category !== false,
            visible_attributes: ii.visible_attributes && typeof ii.visible_attributes === 'object' ? Object.fromEntries(Object.entries(ii.visible_attributes).map(([k, v]) => [k, String(v)])) : {},
            discrepancies: Array.isArray(ii.discrepancies) ? ii.discrepancies.map(String) : [],
            summary: String(ii.summary ?? '')
          }
        }
      : {})
  };
}

export async function generateListing(product, market, ctx) {
  const { brand, categoryRules } = ctx;
  const mode = getMode();
  const started = Date.now();
  let usage = ZERO;
  let listing;
  let violations = [];
  let feedback = null;
  let attempts = 0;
  const history = [];

  while (attempts < MAX_ATTEMPTS) {
    attempts++;
    if (mode === 'live') {
      const r = await callTool({
        system: generationSystem(brand, market, categoryRules),
        user: generationUser(product, categoryRules, feedback),
        tool: LISTING_TOOL
      });
      usage = addUsage(usage, r.usage);
      listing = normalise(r.output);
    } else {
      listing = normalise(mockGenerate(product, market, categoryRules));
    }
    violations = validate(listing, market, product, categoryRules);
    history.push({ attempt: attempts, errors: violations.filter((v) => v.severity === 'error').length });
    if (!hasErrors(violations) || mode !== 'live') break;
    feedback = { violations: violations.filter((v) => v.severity === 'error'), previous: listing };
  }

  let review;
  if (mode === 'live') {
    const r = await callTool({
      system: reviewSystem(brand),
      user: reviewUser(product, market, listing),
      tool: REVIEW_TOOL,
      maxTokens: 1200,
      temperature: 0
    });
    usage = addUsage(usage, r.usage);
    review = r.output;
  } else {
    review = mockReview(listing, violations);
  }

  const passes =
    !hasErrors(violations) &&
    // An image that contradicts the stated product/specs always goes to a human.
    (listing.image_insights?.matches_category ?? true) &&
    !(listing.image_insights?.discrepancies || []).length &&
    review.faithfulness_score >= THRESHOLDS.faithfulness &&
    review.compliance_score >= THRESHOLDS.compliance &&
    review.brand_voice_score >= THRESHOLDS.brand &&
    review.localisation_score >= THRESHOLDS.localisation &&
    (review.unsupported_claims || []).length === 0;

  return {
    productId: product.id,
    marketId: market.id,
    mode,
    hasImage: Boolean(product.image),
    status: passes ? 'approved' : 'needs_review',
    listing,
    violations,
    review,
    attempts,
    history,
    usage,
    elapsedMs: Date.now() - started
  };
}
