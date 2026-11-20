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

function openModal(contentNode) {
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === e.currentTarget) closeModal(); } },
    h('div', { class: 'modal-panel' },
      h('button', { type: 'button', class: 'modal-close', 'aria-label': 'Close', onclick: closeModal }, '×'),
      contentNode));
  $('modalRoot').replaceChildren(backdrop);
}
function closeModal() {
  $('modalRoot').replaceChildren();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

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

function switchTab(tab) {
  state.activeTab = tab;
  for (const btn of document.querySelectorAll('.tab')) btn.classList.toggle('active', btn.dataset.tab === tab);
  for (const panel of document.querySelectorAll('.tab-panel')) panel.hidden = panel.dataset.tab !== tab;
}

async function init() {
  for (const btn of document.querySelectorAll('.tab')) btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  switchTab('source');
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
  $('reviewApproveAll').addEventListener('click', bulkApprove);
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

function tileImage(p) {
  if (p.image) {
    return h('div', { class: 'tile-image-wrap' },
      h('img', { src: imageSrc(p.image), alt: `${p.name} image` }),
      h('button', { type: 'button', class: 'tile-image-remove', onclick: () => { delete p.image; renderProducts(); } }, 'Remove photo'));
  }
  return h('div', { class: 'tile-image-wrap' },
    h('label', { class: 'upload tile-upload' }, '+ Add image',
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

// Any product (catalogue or custom) can be edited in place. For a catalogue product this simulates
// a PIM pushing an updated price/spec (persisted server-side as an override; see "Stale (source
// changed)" in the review queue). A custom product has no server record, so it's just updated locally.
async function saveProductEdit(p, form) {
  const name = form.name.value.trim();
  if (!name) return alert('Name is required.');
  const patch = { brand: form.brand.value.trim(), name, specs: parseAttributes(form.specs.value), raw_notes: form.raw_notes.value.trim() };
  try {
    if (p.custom) {
      Object.assign(p, patch);
    } else {
      const { product } = await api('/api/products/update', { productId: p.id, patch });
      Object.assign(p, product);
    }
    state.editingProduct = null;
    renderProducts();
    await loadReviewQueue();
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  }
}

function removeProduct(p) {
  state.products = state.products.filter((x) => x.id !== p.id);
  if (state.editingProduct === p.id) state.editingProduct = null;
  renderProducts();
}

function editTile(p) {
  const form = h('form', { class: 'edit-product', onsubmit: (e) => e.preventDefault() },
    h('label', {}, 'Brand', h('input', { name: 'brand', value: p.brand })),
    h('label', {}, 'Name', h('input', { name: 'name', value: p.name, required: true })),
    h('label', {}, 'Specs (key: value per line)', h('textarea', { name: 'specs', rows: 4 }, toKV(p.specs))),
    h('label', {}, 'Supplier notes', h('textarea', { name: 'raw_notes', rows: 2 }, p.raw_notes)),
    h('div', { class: 'actions' },
      h('button', { type: 'button', onclick: () => saveProductEdit(p, form) }, 'Save'),
      h('button', { type: 'button', class: 'secondary', onclick: () => { state.editingProduct = null; renderProducts(); } }, 'Cancel')
    )
  );
  return h('div', { class: 'tile editing' }, h('h3', {}, `Editing: ${p.name}`), form);
}

function productTile(p, checked) {
  if (state.editingProduct === p.id) return editTile(p);
  return h('div', { class: 'tile' },
    h('label', { class: 'tile-select' }, h('input', { type: 'checkbox', 'data-id': p.id, checked })),
    tileImage(p),
    h('div', { class: 'tile-body' },
      h('b', {}, p.name),
      h('div', { class: 'hint' }, `${p.sku} · ${p.category}`),
      h('div', { class: 'tile-specs' }, Object.entries(p.specs).slice(0, 3).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')),
      h('p', { class: 'risky tile-notes' }, p.raw_notes),
      h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'link', onclick: () => { state.editingProduct = p.id; renderProducts(); } }, 'Edit'),
        h('button', { type: 'button', class: 'link', onclick: () => removeProduct(p) }, 'Remove')
      )
    )
  );
}

function renderProducts() {
  $('productCount').textContent = `${state.products.length} products · click to expand`;
  const unchecked = new Set([...document.querySelectorAll('#products input[data-id]:not(:checked)')].map((c) => c.dataset.id));
  const tiles = state.products.map((p) => productTile(p, !unchecked.has(p.id)));
  $('products').replaceChildren(...(tiles.length ? tiles : [h('p', { class: 'hint' }, 'No products left — add one below.')]));
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
  $('detail').replaceChildren();
  $('run').disabled = true;
  switchTab('results');

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
const sc = (label, v, min) => h('div', { class: 'score' }, h('b', { class: v >= min ? 'ok' : 'err' }, v), label);

// Explains, in plain language, exactly which gate(s) kept this listing from auto-approving —
// works for both a fresh /api/generate result and a stored review-queue entry (same field shapes).
function reviewReasons(r) {
  const reasons = [];
  const errs = (r.violations || []).filter((v) => v.severity === 'error');
  if (errs.length) reasons.push(`${errs.length} deterministic rule violation${errs.length > 1 ? 's' : ''} (listed below)`);
  const ii = r.listing?.image_insights;
  if (ii && ii.matches_category === false) reasons.push('the product image does not match the stated category');
  if ((ii?.discrepancies || []).length) reasons.push('the image conflicts with the product specs');

  if (r.mode !== 'live') {
    reasons.push('offline mock mode: no real Claude review ran, so the brand-voice and localisation scores below are fixed placeholders that never clear the threshold — connect an Anthropic API key to see real scores and real auto-approval');
    return reasons;
  }

  const rv = r.review || {};
  const t = state.config.thresholds;
  if (rv.faithfulness_score < t.faithfulness) reasons.push(`faithfulness score ${rv.faithfulness_score} is below the required ${t.faithfulness}`);
  if (rv.compliance_score < t.compliance) reasons.push(`compliance score ${rv.compliance_score} is below the required ${t.compliance}`);
  if (rv.brand_voice_score < t.brand) reasons.push(`brand voice score ${rv.brand_voice_score} is below the required ${t.brand}`);
  if (rv.localisation_score < t.localisation) reasons.push(`localisation score ${rv.localisation_score} is below the required ${t.localisation}`);
  if ((rv.unsupported_claims || []).length) reasons.push(`${rv.unsupported_claims.length} unsupported claim${rv.unsupported_claims.length > 1 ? 's' : ''} flagged by the review`);
  return reasons;
}

const whyReviewBlock = (r) =>
  r.status === 'approved' || r.status === 'human_approved'
    ? h('p', { class: 'ok' }, 'Passed every automated check.')
    : h('div', { class: 'why-review' }, h('b', {}, 'Why this needs review:'), h('ul', {}, reviewReasons(r).map((reason) => h('li', {}, reason))));

function renderDetail(p, m, r) {
  if (r.status === 'error') return $('detail').replaceChildren(h('p', { class: 'err' }, `Error: ${r.error}`));
  const l = r.listing;
  const errs = r.violations.filter((v) => v.severity === 'error');
  const warns = r.violations.filter((v) => v.severity === 'warn');
  const rv = r.review;

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

  const t = state.config.thresholds;
  const qa = h('div', { class: 'panel' },
    h('h3', {}, `Quality gate: ${r.status === 'approved' ? 'auto-approved' : 'routed to human review'}`),
    whyReviewBlock(r),
    h('div', { class: 'scores' }, sc('faithful', rv.faithfulness_score, t.faithfulness), sc('compliance', rv.compliance_score, t.compliance), sc('brand voice', rv.brand_voice_score, t.brand), sc('localisation', rv.localisation_score, t.localisation)),
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
  const tabCount = $('reviewTabCount');
  tabCount.hidden = stats.needsReview === 0;
  tabCount.textContent = stats.needsReview;
  const approveAllBtn = $('reviewApproveAll');
  approveAllBtn.textContent = `Approve all pending (${stats.needsReview})`;
  approveAllBtn.disabled = stats.needsReview === 0;
  renderReviewList(shown);
}

// Bulk-clears the pending queue by approving everything with status 'needs_review' as-is.
// Stale items are skipped (their source product changed; regenerate those individually first
// rather than rubber-stamping content built from outdated specs).
async function bulkApprove() {
  const { items } = await api('/api/review/queue?status=needs_review');
  const staleCount = items.filter((e) => e.stale).length;
  const target = items.filter((e) => !e.stale);
  if (!target.length) {
    alert(staleCount ? `All ${staleCount} pending item(s) are stale — regenerate them individually first.` : 'Nothing pending to approve.');
    return;
  }
  const skipNote = staleCount ? ` (${staleCount} stale item${staleCount > 1 ? 's' : ''} will be skipped — regenerate ${staleCount > 1 ? 'those' : 'it'} individually first)` : '';
  if (!confirm(`Approve all ${target.length} pending item(s) as-is?${skipNote}`)) return;

  const reviewer = $('reviewerName').value.trim();
  const btn = $('reviewApproveAll');
  const status = $('reviewBulkStatus');
  btn.disabled = true;
  let done = 0;
  const tick = () => (status.textContent = `Approving ${done}/${target.length}...`);
  tick();
  await pool(target, 4, async (entry) => {
    try {
      await api('/api/review/decision', { productId: entry.productId, marketId: entry.marketId, audienceId: entry.audienceId, decision: 'approved', reviewer, note: 'Bulk approved' });
    } catch (err) {
      console.error(`Bulk approve failed for ${entry.productName} / ${entry.marketLabel}: ${err.message}`);
    }
    done++;
    tick();
  });
  status.textContent = `Approved ${done}/${target.length}.`;
  await loadReviewQueue();
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
    await api('/api/review/decision', {
      productId: entry.productId,
      marketId: entry.marketId,
      audienceId: entry.audienceId,
      decision,
      listing: changed ? edited : undefined,
      reviewer: $('reviewerName').value.trim(),
      note: form.note.value.trim()
    });
    state.openReview = null;
    closeModal();
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
    h('h3', {}, `Quality gate: ${entry.status === 'approved' ? 'auto-approved' : entry.status === 'human_approved' ? 'human-approved' : entry.status === 'human_rejected' ? 'human-rejected' : 'routed to human review'}`),
    whyReviewBlock(entry),
    entry.review
      ? h('div', { class: 'scores' },
          sc('faithful', entry.review.faithfulness_score, state.config.thresholds.faithfulness),
          sc('compliance', entry.review.compliance_score, state.config.thresholds.compliance),
          sc('brand voice', entry.review.brand_voice_score, state.config.thresholds.brand),
          sc('localisation', entry.review.localisation_score, state.config.thresholds.localisation))
      : null,
    entry.review ? h('p', { class: 'note' }, entry.review.summary) : null,
    h('h3', {}, 'Deterministic rules'),
    errs.length || warns.length
      ? h('ul', {}, [...errs.map((v) => h('li', { class: 'err' }, `${v.field}: ${v.message}`)), ...warns.map((v) => h('li', { class: 'wrn' }, `${v.field}: ${v.message}`))])
      : h('p', { class: 'ok' }, 'All deterministic rules passed.'),
    entry.human
      ? h('p', { class: 'note mt' }, h('b', {}, `${STATUS_LABEL[entry.status]} `), `by ${entry.human.reviewer || 'unnamed reviewer'} on ${new Date(entry.human.decidedAt).toLocaleString()}`,
          entry.human.edited ? ' — listing was edited before this decision' : '', entry.human.note ? ` — "${entry.human.note}"` : '')
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

  const header = h('h2', { class: 'modal-title' }, `${entry.productName} — ${entry.marketLabel}`,
    entry.audienceId && entry.audienceId !== 'general' ? h('span', { class: 'tag' }, entry.audienceLabel) : null);

  openModal(h('div', {}, header, h('div', { class: 'cols' }, source, h('div', { class: 'panel' }, h('h3', {}, 'Edit and decide'), form, actions))));
}

init().catch((e) => document.body.prepend(h('p', { class: 'err' }, `Failed to load: ${e.message}`)));
