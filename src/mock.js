// OFFLINE MOCK. Used only when ANTHROPIC_API_KEY is not set, so the UI, validator and ROI maths can be
// smoke-tested without network access. It does NOT localise or screen claims like Claude does: output is
// English with a [MOCK] marker, and results are flagged as mock in the UI. Real runs always use Claude.

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export function mockGenerate(product, market, categoryRules) {
  const specs = Object.entries(product.specs);
  const tag = `[MOCK ${market.locale}]`;
  const rules = categoryRules[product.category] || {};
  const attributes = Object.fromEntries(specs.slice(0, 6).map(([k, v]) => [k, String(v)]));
  for (const key of rules.required_attributes || []) attributes[key] ??= 'n/a';
  const bullets = specs.slice(0, market.bullet_count).map(([k, v]) => clip(`${k.replace(/_/g, ' ')}: ${v}`, market.bullet_max));
  while (bullets.length < market.bullet_count) bullets.push('Designed for everyday use');
  const description = clip(
    `${tag} ${product.name} from ${product.brand}. ` + specs.map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}.`).join(' ') + ' Offline mock output for UI testing only.',
    market.description_max
  );
  return {
    title: clip(`${product.brand} ${product.name}`, market.title_max),
    bullets,
    description: description.padEnd(market.description_min, ' '),
    attributes,
    seo_keywords: [product.name, product.brand, product.category],
    image_alt_text: clip(`${product.name} product photo`, 125),
    legal_notice: rules.legal_notice_required ? `${tag} Legal notice placeholder.` : '',
    claims_removed: [],
    ...(product.image
      ? {
          image_insights: {
            detected_category: product.category,
            matches_category: true,
            visible_attributes: {},
            discrepancies: [],
            summary: '[MOCK] Image received but not analysed. Set ANTHROPIC_API_KEY for real image classification.'
          }
        }
      : {})
  };
}

export function mockReview(listing, violations) {
  const errors = violations.filter((v) => v.severity === 'error').length;
  const score = Math.max(40, 90 - errors * 10);
  return {
    faithfulness_score: score,
    compliance_score: score,
    brand_voice_score: 60,
    localisation_score: 30,
    unsupported_claims: [],
    issues: ['Offline mock: no real review performed.'],
    summary: 'Offline mock review. Set ANTHROPIC_API_KEY for a real Claude review.'
  };
}
