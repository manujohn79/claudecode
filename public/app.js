const $ = (id) => document.getElementById(id);

// DOM builder: always uses textContent, never innerHTML, so model output can never inject markup.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

const state = { config: null, products: [], results: new Map(), selected: null, editingProduct: null, openReview: null };
const keyOf = (p, m, a = 'general') => `${p}|${m}|${a}`;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function renderMode() {
  const live = state.config.mode === 'live';
  const mode = $('mode');
  mode.textContent = live ? `Live: Claude (${state.config.model})` : 'Demo mode (offline mock)';
  mode.className = `badge ${state.config.mode}`;
  $('apiKey').hidden = live;
  $('keyOn').hidden = live;
  $('keyOff').hidden = !live;
}

async function connectKey(e) {
  e.preventDefault();
  const input = $('apiKey');
  const msg = $('keyMsg');
  $('keyOn').disabled = true;
  msg.className = 'hint light';
  msg.textContent = 'Verifying key with Anthropic...';
  try {
    const r = await api('/api/key', { key: input.value.trim() });
    state.config.mode = r.mode;
    state.config.model = r.model;
    msg.textContent = 'Connected. New runs use real Claude output. Key is kept in server memory only.';
  } catch (err) {
    msg.className = 'hint light bad';
    msg.textContent = err.message;
  } finally {
    input.value = '';
    $('keyOn').disabled = false;
    renderMode();
  }
}

async function disconnectKey() {
  const res = await fetch('/api/key', { method: 'DELETE' });
  const r = await res.json();
  state.config.mode = r.mode;
  state.config.model = r.model;
  $('keyMsg').className = 'hint light';
  $('keyMsg').textContent = 'Disconnected. Back to offline demo mode.';
  renderMode();
}

async function init() {
  state.config = await api('/api/config');
  state.products = [...state.config.products];
  renderMode();
  $('keyForm').addEventListener('submit', connectKey);
  $('keyOff').addEventListener('click', disconnectKey);
  $('categorySel').replaceChildren(...state.config.categories.map((c) => h('option', { value: c }, c)));
  $('markets').replaceChildren(
    ...state.config.markets.map((m) => h('label', {}, h('input', { type: 'checkbox', value: m.id, checked: true }), ' ', m.label, ` (${m.locale})`))
  );
  $('audienceSel').replaceChildren(...state.config.audiences.map((a) => h('option', { value: a.id }, a.label)));
  renderProducts();
  $('run').addEventListener('click', run);
  $('custom').addEventListener('submit', addCustom);

  $('reviewerName').value = localStorage.getItem('reviewerName') || '';
  $('reviewerName').addEventListener('change', (e) => localStorage.setItem('reviewerName', e.target.value));
  $('reviewFilter').addEventListener('change', () => loadReviewQueue());
  $('reviewRefresh').addEventListener('click', () => loadReviewQueue());
  await loadReviewQueue();
}

// Optional product image: downscale to max 1024px JPEG in the browser so uploads stay small and fast.
async function fileToImage(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file (JPEG, PNG, WebP or GIF).');
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL('image/jpeg', 0.85);
  return { media_type: 'image/jpeg', data: url.split(',')[1], preview: url };
}

async function setImage(p, file) {
  try {
    p.image = await fileToImage(file);
    renderProducts();
  } catch (err) {
    alert(`Could not use image: ${err.message}`);
  }
}

// A server-attached default image has no .preview (that's only created by the browser-side
// downscale in fileToImage); fall back to a plain data URL built from its media_type + base64 data.
const imageSrc = (img) => img.preview || `data:${img.media_type};base64,${img.data}`;

function imageCell(p) {
  if (p.image) {
    return h('td', {}, h('img', { class: 'thumb', src: imageSrc(p.image), alt: `${p.name} image` }),
      h('button', { type: 'button', class: 'link', onclick: () => { delete p.image; renderProducts(); } }, 'Remove'));
  }
  return h('td', {}, h('label', { class: 'upload' }, '+ Add image',
    h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', class: 'file-hidden', onchange: (e) => setImage(p, e.target.files[0]) })));
}

const toLines = (arr) => (arr || []).join('\n');
const toKV = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}: ${v}`).join('\n');

function parseAttributes(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase().replace(/\s+/g, '_')] = line.slice(i + 1).trim();
  }
  return out;
}

// Catalogue (non-custom) products can be edited in place, to simulate a PIM pushing an updated
// price/spec; this is what the "Stale (source changed)" review-queue filter reacts to.
async function saveProductEdit(p, specsEl, notesEl) {
  try {
    const { product } = await api('/api/products/update', { productId: p.id, patch: { specs: parseAttributes(specsEl.value), raw_notes: notesEl.value.trim() } });
    Object.assign(p, product);
    state.editingProduct = null;
    renderProducts();
    await loadReviewQueue();
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  }
}

function specsAndNotesCells(p) {
  if (state.editingProduct === p.id) {
    let specsEl, notesEl;
    const form = h('div', { class: 'edit-product' },
      h('label', {}, 'Specs (key: value per line)', (specsEl = h('textarea', { rows: 4 }, toKV(p.specs)))),
      h('label', {}, 'Supplier notes', (notesEl = h('textarea', { rows: 2 }, p.raw_notes))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => saveProductEdit(p, specsEl, notesEl) }, 'Save'),
        h('button', { type: 'button', class: 'secondary', onclick: () => { state.editingProduct = null; renderProducts(); } }, 'Cancel')
      )
    );
    return [h('td', { colspan: 2 }, form)];
  }
  return [
    h('td', {}, Object.entries(p.specs).slice(0, 4).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')),
    h('td', { class: 'risky' },
      p.raw_notes,
      !p.custom && h('div', {}, h('button', { type: 'button', class: 'link', onclick: () => { state.editingProduct = p.id; renderProducts(); } }, 'Edit specs / notes')))
  ];
}

function renderProducts() {
  $('productCount').textContent = `${state.products.length} products · click to expand`;
  const unchecked = new Set([...document.querySelectorAll('#products input[data-id]:not(:checked)')].map((c) => c.dataset.id));
  const rows = state.products.map((p) =>
    h('tr', {},
      h('td', {}, h('input', { type: 'checkbox', 'data-id': p.id, checked: !unchecked.has(p.id) })),
      h('td', {}, h('b', {}, p.name), h('div', { class: 'hint' }, `${p.sku} · ${p.category}`)),
      imageCell(p),
      ...specsAndNotesCells(p)
    )
  );
  $('products').replaceChildren(h('tr', {}, h('th', {}), h('th', {}, 'Product'), h('th', {}, 'Image (optional)'), h('th', {}, 'Specs'), h('th', {}, 'Supplier notes (unverified)')), ...rows);
}

async function addCustom(e) {
  e.preventDefault();
  const form = e.target;
  const f = new FormData(form);
  const specs = {};
  for (const line of String(f.get('specs')).split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) specs[line.slice(0, i).trim().toLowerCase().replace(/\s+/g, '_')] = line.slice(i + 1).trim();
  }
  const product = {
    id: `U${state.products.length + 1}`, sku: `CUSTOM-${state.products.length + 1}`,
    brand: f.get('brand'), name: f.get('name'), category: f.get('category'), specs, approved_claims: [], raw_notes: f.get('raw_notes'), custom: true
  };
  const file = form.elements.image?.files?.[0];
  if (file) {
    try { product.image = await fileToImage(file); } catch (err) { alert(`Image skipped: ${err.message}`); }
  }
  state.products.push(product);
  form.reset();
  renderProducts();
}

async function pool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

async function run() {
  const pids = [...document.querySelectorAll('#products input[data-id]:checked')].map((c) => c.dataset.id);
  const mids = [...document.querySelectorAll('#markets input:checked')].map((c) => c.value);
  if (!pids.length || !mids.length) return;
  const products = state.products.filter((p) => pids.includes(p.id));
  const markets = state.config.markets.filter((m) => mids.includes(m.id));
  const audienceId = $('audienceSel').value;
  state.currentAudience = audienceId;
  state.results.clear();
  state.selected = null;
  $('resultsCard').hidden = false;
  $('roiCard').hidden = true;
  $('detail').replaceChildren();
  $('run').disabled = true;

  const jobs = products.flatMap((p) => markets.map((m) => ({ p, m })));
  let done = 0;
  const started = performance.now();
  const tick = () => ($('progress').textContent = `${done}/${jobs.length} listings`);
  renderMatrix(products, markets);
  tick();

  await pool(jobs, 4, async ({ p, m }) => {
    try {
      const body = { marketId: m.id, audienceId, ...(p.custom ? { product: { ...p, image: undefined } } : { productId: p.id }), ...(p.image ? { image: { media_type: p.image.media_type, data: p.image.data } } : {}) };
      state.results.set(keyOf(p.id, m.id, audienceId), await api('/api/generate', body));
    } catch (err) {
      state.results.set(keyOf(p.id, m.id, audienceId), { status: 'error', error: err.message });
    }
    done++;
    tick();
    renderMatrix(products, markets);
  });

  const audienceLabel = state.config.audiences.find((a) => a.id === audienceId)?.label || audienceId;
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  $('progress').textContent = `${jobs.length} listings in ${secs}s wall-clock · audience: ${audienceLabel}`;
  $('run').disabled = false;
  const ok = [...state.results.values()].filter((r) => r.listing);
  if (ok.length) {
    const { roi } = await api('/api/roi', { results: ok });
    renderRoi(roi);
  }
  await loadReviewQueue();
}

function renderMatrix(products, markets) {
  const a = state.currentAudience;
  const head = h('tr', {}, h('th', {}, 'Product'), ...markets.map((m) => h('th', {}, m.label)));
  const rows = products.map((p) =>
    h('tr', {}, h('td', {}, p.name), ...markets.map((m) => {
      const r = state.results.get(keyOf(p.id, m.id, a));
      const sel = state.selected === keyOf(p.id, m.id, a);
      if (!r) return h('td', {}, h('span', { class: 'cell pending' }, '…'));
      const label = r.status === 'approved' ? 'Approved' : r.status === 'needs_review' ? 'Review' : 'Error';
      const extra = r.attempts > 1 ? ` · ${r.attempts} tries` : '';
      return h('td', {}, h('span', { class: `cell ${r.status}${sel ? ' selected' : ''}`, onclick: () => { state.selected = keyOf(p.id, m.id, a); renderMatrix(products, markets); renderDetail(p, m, r); } }, label + extra));
    }))
  );
  $('matrix').replaceChildren(h('table', {}, head, ...rows));
}

const dl = (obj) => h('dl', {}, Object.entries(obj).flatMap(([k, v]) => [h('dt', {}, k.replace(/_/g, ' ')), h('dd', {}, String(v))]));
const lenNote = (s, max) => h('span', { class: `len ${s.length > max ? 'err' : ''}` }, ` (${s.length}/${max})`);

function renderDetail(p, m, r) {
  if (r.status === 'error') return $('detail').replaceChildren(h('p', { class: 'err' }, `Error: ${r.error}`));
  const l = r.listing;
  const errs = r.violations.filter((v) => v.severity === 'error');
  const warns = r.violations.filter((v) => v.severity === 'warn');
  const rv = r.review;
  const sc = (label, v, min) => h('div', { class: 'score' }, h('b', { class: v >= min ? 'ok' : 'err' }, v), label);

  const source = h('div', { class: 'panel' },
    h('h3', {}, 'Source (input)'), h('b', {}, p.name),
    p.image && h('div', {}, h('img', { class: 'thumb big', src: imageSrc(p.image), alt: `${p.name} product image` })),
    dl(p.specs),
    h('h3', {}, 'Supplier notes'), h('p', { class: 'risky' }, p.raw_notes),
    h('h3', {}, 'Claims Claude removed'),
    l.claims_removed.length ? h('ul', {}, l.claims_removed.map((c) => h('li', {}, h('b', {}, c.claim), ': ', c.reason))) : h('p', { class: 'note' }, 'None')
  );

  const audienceLabel = state.config.audiences.find((a) => a.id === r.audienceId)?.label;
  const out = h('div', { class: 'panel' },
    h('h3', {}, `Generated listing: ${m.label} (${m.locale})`, audienceLabel && r.audienceId !== 'general' ? h('span', { class: 'tag' }, audienceLabel) : null),
    h('p', {}, h('b', {}, l.title), lenNote(l.title, m.title_max)),
    h('ul', {}, l.bullets.map((b) => h('li', {}, b, lenNote(b, m.bullet_max)))),
    h('p', {}, l.description, lenNote(l.description, m.description_max)),
    dl(l.attributes),
    l.legal_notice && h('p', { class: 'note' }, h('b', {}, 'Legal notice: '), l.legal_notice),
    h('p', {}, l.seo_keywords.map((k) => h('span', { class: 'tag' }, k))),
    h('p', { class: 'note' }, `Alt text: ${l.image_alt_text}`)
  );

  const qa = h('div', { class: 'panel' },
    h('h3', {}, `Quality gate: ${r.status === 'approved' ? 'auto-approved' : 'routed to human review'}`),
    h('div', { class: 'scores' }, sc('faithful', rv.faithfulness_score, 85), sc('compliance', rv.compliance_score, 85), sc('brand voice', rv.brand_voice_score, 70), sc('localisation', rv.localisation_score, 70)),
    h('p', { class: 'note' }, `Claude review: ${rv.summary}`),
    rv.unsupported_claims.length ? h('ul', {}, rv.unsupported_claims.map((c) => h('li', { class: 'err' }, `Unsupported: ${c}`))) : null,
    h('p', { class: 'note' }, `Generation attempts: ${r.history.map((x) => `#${x.attempt}: ${x.errors} rule violations`).join(' → ')} · ${(r.elapsedMs / 1000).toFixed(1)}s · tokens in/out ${r.usage.input + r.usage.cacheRead + r.usage.cacheWrite}/${r.usage.output} (cached ${r.usage.cacheRead})`),
    errs.length || warns.length
      ? h('ul', {}, [...errs.map((v) => h('li', { class: 'err' }, `${v.field}: ${v.message}`)), ...warns.map((v) => h('li', { class: 'wrn' }, `${v.field}: ${v.message}`))])
      : h('p', { class: 'ok' }, 'All deterministic rules passed.')
  );

  const ii = l.image_insights;
  const imagePanel = ii && h('div', { class: 'panel mt' },
    h('h3', {}, 'Image classification'),
    h('p', {},
      h('span', { class: 'tag' }, `Detected: ${ii.detected_category || 'unknown'}`), ' ',
      ii.matches_category ? h('span', { class: 'ok' }, 'Matches stated category') : h('b', { class: 'err' }, 'Does NOT match stated category')),
    h('p', { class: 'note' }, ii.summary),
    Object.keys(ii.visible_attributes).length ? h('div', {}, h('h3', {}, 'Visible in image'), dl(ii.visible_attributes)) : null,
    ii.discrepancies.length ? h('ul', {}, ii.discrepancies.map((d) => h('li', { class: 'err' }, `Image vs specs: ${d}`))) : null
  );

  $('detail').replaceChildren(h('div', { class: 'cols' }, source, out), imagePanel, h('div', { class: 'mt' }, qa));
}

const eur = (n) => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const num = (n) => new Intl.NumberFormat('en-IE').format(n);

function renderRoi(r) {
  if (!r) return;
  const a = state.config.assumptions;
  const kpi = (v, label) => h('div', { class: 'kpi' }, h('b', {}, v), h('span', {}, label));
  $('roiCard').hidden = false;
  $('roi').replaceChildren(
    h('div', { class: 'kpis' },
      kpi(`${r.savings.timePct}%`, 'less effort (this run)'),
      kpi(`${r.savings.pct}%`, 'lower cost per listing'),
      kpi(`${r.avgSecondsPerListing}s`, `machine time per listing vs ${a.manual.minutes_per_listing} min manual`),
      kpi(`${r.autoApprovedPct}%`, 'auto-approved, rest to human review'),
      kpi(`${r.firstPassViolationPct}%`, `failed rules on first try (${r.autoRepaired} auto-repaired)`)
    ),
    h('p', {}, `This run: ${r.listings} listings. Manual baseline ${num(r.manual.minutes)} min / ${eur(r.manual.eur)}; with Claude ${num(r.automated.minutes)} min / ${eur(r.automated.eur)} (API cost ${r.automated.apiEur.toFixed(3)} EUR, human review ${eur(r.automated.reviewEur)}). Saved ${r.savings.hours} h.`),
    h('p', {}, h('b', {}, `Projection: ${num(a.scale_projection.skus)} SKUs × ${a.scale_projection.markets} markets = ${num(r.projection.listings)} listings. `),
      `Manual ${num(r.projection.manualHours)} h (${eur(r.projection.manualEur)}) vs automated ${num(r.projection.automatedHours)} h (${eur(r.projection.automatedEur)}). Estimated saving ${eur(r.projection.savedEur)}.`),
    h('p', { class: 'note' }, `${r.live ? 'Token usage and timing measured from live Claude calls.' : 'OFFLINE MOCK RUN: figures are not representative. Set ANTHROPIC_API_KEY for real numbers.'} Manual baseline (${a.manual.minutes_per_listing} min/listing at ${a.manual.hourly_cost_eur} EUR/h) and review times are illustrative assumptions in data/assumptions.json.`)
  );
}

const STATUS_LABEL = { approved: 'Auto-approved', needs_review: 'Needs review', human_approved: 'Human approved', human_rejected: 'Human rejected' };

async function loadReviewQueue() {
  const { items, stats } = await api('/api/review/queue');
  const filter = $('reviewFilter').value;
  const shown = filter === 'stale' ? items.filter((e) => e.stale) : filter ? items.filter((e) => e.status === filter) : items;
  const staleCount = items.filter((e) => e.stale).length;
  $('reviewCount').textContent = `${stats.needsReview} awaiting review · ${staleCount} stale · ${stats.total} total`;
  renderReviewList(shown);
}

function renderReviewList(items) {
  const rows = items
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .map((e) =>
      h('tr', {},
        h('td', {}, h('b', {}, e.productName)),
        h('td', {}, e.marketLabel),
        h('td', {}, e.audienceLabel),
        h('td', {}, h('span', { class: `cell ${e.status}` }, STATUS_LABEL[e.status] || e.status)),
        h('td', {}, e.stale ? h('span', { class: 'cell needs_review' }, 'Stale') : h('span', { class: 'hint' }, 'Current')),
        h('td', { class: 'hint' }, new Date(e.generatedAt).toLocaleString()),
        h('td', {},
          h('button', { type: 'button', class: 'secondary', onclick: () => openReviewItem(e.productId, e.marketId, e.audienceId) }, 'Open'),
          e.stale ? h('button', { type: 'button', class: 'secondary', onclick: () => regenerate(e.productId, e.marketId, e.audienceId) }, 'Regenerate') : null)
      )
    );
  $('reviewList').replaceChildren(
    h('tr', {}, h('th', {}, 'Product'), h('th', {}, 'Market'), h('th', {}, 'Audience'), h('th', {}, 'Status'), h('th', {}, 'Source'), h('th', {}, 'Generated'), h('th', {})),
    ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: 7, class: 'hint' }, 'Nothing here.'))])
  );
}

async function openReviewItem(productId, marketId, audienceId) {
  state.openReview = { productId, marketId, audienceId };
  const entry = await api(`/api/review/item?productId=${encodeURIComponent(productId)}&marketId=${encodeURIComponent(marketId)}&audienceId=${encodeURIComponent(audienceId || 'general')}`);
  renderReviewDetail(entry);
}

async function regenerate(productId, marketId, audienceId) {
  try {
    await api('/api/review/regenerate', { productId, marketId, audienceId });
    await loadReviewQueue();
    if (state.openReview?.productId === productId && state.openReview?.marketId === marketId && state.openReview?.audienceId === audienceId) {
      await openReviewItem(productId, marketId, audienceId);
    }
  } catch (err) {
    alert(`Could not regenerate: ${err.message}`);
  }
}

function buildEditedListing(original, form) {
  return {
    title: form.title.value.trim(),
    bullets: form.bullets.value.split('\n').map((s) => s.trim()).filter(Boolean),
    description: form.description.value.trim(),
    attributes: parseAttributes(form.attributes.value),
    seo_keywords: form.seo_keywords.value.split('\n').map((s) => s.trim()).filter(Boolean),
    image_alt_text: form.image_alt_text.value.trim(),
    legal_notice: form.legal_notice.value.trim(),
    claims_removed: original.claims_removed
  };
}

const canonical = (l) => JSON.stringify({
  title: l.title, bullets: l.bullets, description: l.description, attributes: l.attributes,
  seo_keywords: l.seo_keywords, image_alt_text: l.image_alt_text, legal_notice: l.legal_notice
});

async function submitDecision(entry, decision, form, msgEl) {
  const edited = buildEditedListing(entry.listing, form);
  const changed = canonical(edited) !== canonical(entry.listing);
  msgEl.textContent = 'Saving...';
  try {
    const updated = await api('/api/review/decision', {
      productId: entry.productId,
      marketId: entry.marketId,
      audienceId: entry.audienceId,
      decision,
      listing: changed ? edited : undefined,
      reviewer: $('reviewerName').value.trim(),
      note: form.note.value.trim()
    });
    renderReviewDetail(updated);
    await loadReviewQueue();
  } catch (err) {
    msgEl.className = 'hint bad';
    msgEl.textContent = err.message;
  }
}

function renderReviewDetail(entry) {
  const l = entry.listing;
  const errs = (entry.violations || []).filter((v) => v.severity === 'error');
  const warns = (entry.violations || []).filter((v) => v.severity === 'warn');

  const staleNotice = entry.stale && h('p', { class: 'hint bad' },
    'The source product has changed since this listing was generated. ',
    h('button', { type: 'button', class: 'link', onclick: () => regenerate(entry.productId, entry.marketId, entry.audienceId) }, 'Regenerate now'));

  const source = h('div', { class: 'panel' },
    h('h3', {}, 'Source (input)'), h('b', {}, entry.productName),
    entry.audienceId && entry.audienceId !== 'general' ? h('span', { class: 'tag' }, entry.audienceLabel) : null,
    staleNotice,
    dl(entry.product.specs),
    h('h3', {}, 'Supplier notes'), h('p', { class: 'risky' }, entry.product.raw_notes),
    h('h3', {}, 'Claims Claude removed'),
    l.claims_removed.length ? h('ul', {}, l.claims_removed.map((c) => h('li', {}, h('b', {}, c.claim), ': ', c.reason))) : h('p', { class: 'note' }, 'None'),
    h('h3', {}, 'Claude / gate review'),
    entry.review ? h('p', { class: 'note' }, entry.review.summary) : null,
    errs.length || warns.length
      ? h('ul', {}, [...errs.map((v) => h('li', { class: 'err' }, `${v.field}: ${v.message}`)), ...warns.map((v) => h('li', { class: 'wrn' }, `${v.field}: ${v.message}`))])
      : h('p', { class: 'ok' }, 'All deterministic rules passed.'),
    entry.human
      ? h('p', { class: 'note mt' }, h('b', {}, `${STATUS_LABEL[entry.status]} `), `by ${entry.human.reviewer || 'unnamed reviewer'} on ${new Date(entry.human.decidedAt).toLocaleString()}`, entry.human.note ? ` — "${entry.human.note}"` : '')
      : null
  );

  const form = h('form', { class: 'edit-form', onsubmit: (e) => e.preventDefault() },
    h('label', {}, 'Title', h('input', { name: 'title', value: l.title })),
    h('label', {}, 'Bullets (one per line)', h('textarea', { name: 'bullets', rows: 5 }, toLines(l.bullets))),
    h('label', {}, 'Description', h('textarea', { name: 'description', rows: 5 }, l.description)),
    h('label', {}, 'Attributes (key: value per line)', h('textarea', { name: 'attributes', rows: 4 }, toKV(l.attributes))),
    h('label', {}, 'SEO keywords (one per line)', h('textarea', { name: 'seo_keywords', rows: 3 }, toLines(l.seo_keywords))),
    h('label', {}, 'Image alt text', h('input', { name: 'image_alt_text', value: l.image_alt_text })),
    h('label', {}, 'Legal notice', h('textarea', { name: 'legal_notice', rows: 2 }, l.legal_notice)),
    h('label', {}, 'Reviewer note (optional)', h('textarea', { name: 'note', rows: 2 }, entry.human?.note || ''))
  );
  const msg = h('span', { class: 'hint' });
  const actions = h('div', { class: 'actions' },
    h('button', { type: 'button', onclick: () => submitDecision(entry, 'approved', form, msg) }, 'Approve'),
    h('button', { type: 'button', class: 'secondary bad', onclick: () => submitDecision(entry, 'rejected', form, msg) }, 'Reject'),
    msg
  );

  $('reviewDetail').replaceChildren(h('div', { class: 'cols' }, source, h('div', { class: 'panel' }, h('h3', {}, 'Edit and decide'), form, actions)));
}

init().catch((e) => document.body.prepend(h('p', { class: 'err' }, `Failed to load: ${e.message}`)));
