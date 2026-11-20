// Business-impact model. Measured inputs (tokens, seconds, review outcomes) come from real runs;
// manual baselines and prices come from data/assumptions.json and are explicit, editable assumptions.

export function costUsd(usage, pricing) {
  const p = pricing;
  return (
    (usage.input * p.input +
      usage.output * p.output +
      usage.cacheWrite * p.input * p.cache_write_multiplier +
      usage.cacheRead * p.input * p.cache_read_multiplier) /
    1e6
  );
}

export function computeRoi(results, assumptions) {
  const n = results.length;
  if (!n) return null;
  const { manual, automated, pricing_usd_per_million_tokens: pricing, scale_projection: scale } = assumptions;
  const rate = manual.hourly_cost_eur;

  const approved = results.filter((r) => r.status === 'approved').length;
  const needsReview = n - approved;
  const apiUsd = results.reduce((s, r) => s + costUsd(r.usage, pricing), 0);
  const apiEur = apiUsd * automated.eur_per_usd;
  const reviewMin = approved * automated.human_review_minutes_approved + needsReview * automated.human_review_minutes_needs_review;
  const reviewEur = (reviewMin / 60) * rate;
  const manualMin = n * manual.minutes_per_listing;
  const manualEur = (manualMin / 60) * rate;
  const autoEur = apiEur + reviewEur;
  const machineSec = results.reduce((s, r) => s + r.elapsedMs, 0) / 1000;
  const autoMin = machineSec / 60 + reviewMin;

  const perListing = autoEur / n;
  const projListings = scale.skus * scale.markets;
  const rejected = results.reduce((s, r) => s + (r.history[0]?.errors > 0 ? 1 : 0), 0);
  const repaired = results.filter((r) => r.history[0]?.errors > 0 && !r.violations.some((v) => v.severity === 'error')).length;

  return {
    listings: n,
    live: results.every((r) => r.mode === 'live'),
    approved,
    needsReview,
    autoApprovedPct: Math.round((approved / n) * 100),
    firstPassViolationPct: Math.round((rejected / n) * 100),
    autoRepaired: repaired,
    avgSecondsPerListing: +(machineSec / n).toFixed(1),
    manual: { minutes: Math.round(manualMin), eur: Math.round(manualEur) },
    automated: { minutes: Math.round(autoMin), eur: +autoEur.toFixed(2), apiEur: +apiEur.toFixed(3), reviewEur: +reviewEur.toFixed(2) },
    savings: {
      hours: +((manualMin - autoMin) / 60).toFixed(1),
      eur: Math.round(manualEur - autoEur),
      pct: Math.round((1 - autoEur / manualEur) * 100),
      timePct: Math.round((1 - autoMin / manualMin) * 100)
    },
    projection: {
      listings: projListings,
      manualEur: Math.round((projListings * manual.minutes_per_listing * rate) / 60),
      automatedEur: Math.round(projListings * perListing),
      savedEur: Math.round((projListings * manual.minutes_per_listing * rate) / 60 - projListings * perListing),
      manualHours: Math.round((projListings * manual.minutes_per_listing) / 60),
      automatedHours: Math.round((projListings * (autoMin / n)) / 60)
    }
  };
}
