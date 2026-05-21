window.onerror = function(msg, src, line, col, err) {
  const d = document.getElementById('js-debug');
  const c = document.getElementById('js-debug-content');
  if (d && c) {
    d.style.display = 'block';
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px dotted #7f1d1d;padding:4px 0;margin-top:4px';
    div.textContent = '⚠ ' + msg + ' @ line ' + line + ':' + col;
    c.appendChild(div);
  }
  return false;
};
window.addEventListener('unhandledrejection', function(ev) {
  const d = document.getElementById('js-debug');
  const c = document.getElementById('js-debug-content');
  if (d && c) {
    d.style.display = 'block';
    const div = document.createElement('div');
    div.style.cssText = 'border-top:1px dotted #7f1d1d;padding:4px 0;margin-top:4px';
    div.textContent = '⚠ Promise: ' + (ev.reason && ev.reason.message || ev.reason);
    c.appendChild(div);
  }
});
const $ = id => document.getElementById(id);
const feed = $('feed');
let firstStatus = true;
function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; }
function addRow(tag, msg, ok) {
  const row = el('div', 'feed-row');
  const time = new Date().toLocaleTimeString('fr-FR', { hour12: false });
  row.appendChild(el('div', 'feed-time', time));
  row.appendChild(el('div', 'feed-tag ' + (ok===false?'err':ok===true?'ok':''), tag));
  row.appendChild(el('div', 'feed-msg', msg));
  const empty = feed.querySelector('.feed-empty');
  if (empty) empty.remove();
  feed.insertBefore(row, feed.firstChild);
  while (feed.children.length > 50) feed.removeChild(feed.lastChild);
}
function flashUpdate(target, val) { const t = String(val); if (target.textContent === t) return; target.textContent = t; target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
async function api(path) { const r = await fetch(path); const j = await r.json(); if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status)); return j; }
async function refresh() {
  try {
    const s = await api('/api/status');
    flashUpdate($('m-status'), 'OK');
    $('m-status-sub').textContent = 'connecté';
    flashUpdate($('m-ping'), s.ping_ms + ' ms');
    flashUpdate($('m-wire'), s.wire_version);
    $('m-wire-sub').textContent = 'compat ' + s.mongo_compat;
    flashUpdate($('m-version'), s.ferretdb_version);
    flashUpdate($('m-backend'), s.backend);
    const targetMasked = (s.target || '').replace(/app_[a-f0-9-]+/, '<private app>').replace(/ng_[a-f0-9-]+/, '<network-group>');
    $('m-target').textContent = targetMasked;
    flashUpdate($('m-docs'), s.docs_in_dashboard);
    $('nav-status').textContent = 'Live';
    $('ft-version').textContent = s.ferretdb_version;
    $('ft-target').textContent = targetMasked;
    if (firstStatus) { addRow('status', 'Connecté à ' + s.target + ' (FerretDB ' + s.ferretdb_version + ')', true); firstStatus = false; }
  } catch (e) {
    $('m-status').textContent = 'KO';
    $('m-status-sub').textContent = e.message;
    $('nav-status').textContent = 'Erreur';
    if (firstStatus) { addRow('status', 'Erreur : ' + e.message, false); firstStatus = false; }
  }
}
setInterval(refresh, 2000);
refresh();
$('btn-insert').onclick = async () => {
  try { const r = await api('/api/insert'); addRow('insert', '_id ' + r._id + ' — ' + r.latency_ms + ' ms', true); }
  catch(e) { addRow('insert', e.message, false); }
};
$('btn-find').onclick = async () => {
  try { const r = await api('/api/find'); addRow('find', r.count + ' docs en ' + r.latency_ms + ' ms (last 20, sort -ts)', true); }
  catch(e) { addRow('find', e.message, false); }
};
$('btn-aggregate').onclick = async () => {
  try {
    const r = await api('/api/aggregate');
    const summary = r.byTag.map(b => b._id + ':' + b.count + '/' + b.sum_value).join(' · ');
    addRow('aggregate', '$group by tag — ' + r.latency_ms + ' ms — ' + (summary || '(vide)'), true);
  } catch(e) { addRow('aggregate', e.message, false); }
};
$('btn-bench').onclick = async () => {
  const b = $('btn-bench');
  b.disabled = true; b.textContent = '⚡ Running…';
  addRow('bench', 'Démarrage : 500 inserts + 200 finds + 100 updates…');
  try {
    const r = await api('/api/quickbench');
    $('bench-section').style.display = 'block';
    const grid = $('bench-grid');
    grid.replaceChildren();
    function brow(k, v) { const row = el('div','bench-row'); row.appendChild(el('span','k',k)); row.appendChild(el('span','v',v)); return row; }
    ['insert','find','update'].forEach(k => {
      const m = r[k];
      const card = el('div', 'bench-card');
      card.appendChild(el('h4', null, k + ' (' + (m.n_docs||m.n) + ' ops)'));
      card.appendChild(brow('p50', m.p50 + ' ms'));
      card.appendChild(brow('p95', m.p95 + ' ms'));
      card.appendChild(brow('p99', m.p99 + ' ms'));
      card.appendChild(brow('avg', m.avg + ' ms'));
      if (k === 'insert') card.appendChild(brow('throughput', r.insert.throughput + ' /s'));
      grid.appendChild(card);
    });
    addRow('bench', 'OK — insert p50=' + r.insert.p50 + 'ms · find p50=' + r.find.p50 + 'ms · update p50=' + r.update.p50 + 'ms', true);
  } catch(e) { addRow('bench', e.message, false); }
  b.disabled = false; b.textContent = '⚡ Quick bench (800 ops)';
};
$('btn-drop').onclick = async () => {
  if (!confirm('Drop la collection dashboard ?')) return;
  try { await api('/api/drop_dashboard'); addRow('drop', 'collection dashboard supprimée', true); }
  catch(e) { addRow('drop', e.message, false); }
};
function setCompat(name, ok, detail) {
  const el2 = document.querySelector('[data-test="' + name + '"]');
  if (!el2) return;
  el2.className = 'compat-state ' + (ok ? 'ok' : 'err');
  el2.textContent = ok ? '✓ OK' : '✗ KO';
  if (detail) el2.title = detail;
}
// ─── Patterns Mongo réels ───
const patternOut = $('pattern-out');
function clearPatternOut() { while (patternOut.firstChild) patternOut.removeChild(patternOut.firstChild); }
function patternNarrative(text) { const d = el('div', 'pattern-narrative', text); patternOut.appendChild(d); }
function patternBlock(text, tight) { const d = el('pre', 'pattern-block' + (tight ? ' tight' : ''), typeof text === 'string' ? text : JSON.stringify(text, null, 2)); patternOut.appendChild(d); }
function patternHeading(text) { const d = el('div', null, text); d.style.cssText = 'font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:hsl(0,0%,55%);margin:10px 0 6px 0'; patternOut.appendChild(d); }
function patternError(msg) { const d = el('div', 'pattern-block'); d.style.color = '#fca5a5'; d.textContent = '❌ ' + msg; patternOut.appendChild(d); }

async function runPattern(ep, title, render) {
  clearPatternOut();
  patternHeading(title);
  const loading = el('div', null, 'Chargement…');
  loading.style.color = 'hsl(0,0%,50%)';
  patternOut.appendChild(loading);
  try {
    const r = await api(ep);
    patternOut.removeChild(loading);
    if (r.narrative) patternNarrative(r.narrative);
    render(r);
    addRow('pattern', title + ' ✓', true);
  } catch (e) {
    patternOut.removeChild(loading);
    patternError(e.message);
    addRow('pattern', title + ' ❌ ' + e.message, false);
  }
}

$('pat-schema').onclick = () => runPattern('/api/pattern/schema_flex', 'Schema flexibility', r => {
  r.docs.forEach((d, i) => { patternHeading('Document #' + (i + 1)); patternBlock(d, true); });
});
$('pat-paginate').onclick = () => runPattern('/api/pattern/list_paginate', 'Filter + sort + paginate', r => {
  patternBlock('Total matching price >= 50 : ' + r.total_matching + '\\nPage : ' + r.page + ' (taille ' + r.page_size + ')\\nLatency : ' + r.latency_ms + ' ms', true);
  const table = el('table', 'pattern-table');
  const thead = el('thead'); const trh = el('tr'); ['i', 'name', 'price'].forEach(k => trh.appendChild(el('th', null, k))); thead.appendChild(trh); table.appendChild(thead);
  const tbody = el('tbody'); r.rows.forEach(row => { const tr = el('tr'); tr.appendChild(el('td', null, row.i)); tr.appendChild(el('td', null, row.name)); tr.appendChild(el('td', null, row.price)); tbody.appendChild(tr); }); table.appendChild(tbody);
  patternOut.appendChild(table);
});
$('pat-nested').onclick = () => runPattern('/api/pattern/nested_update', 'Update champ imbriqué', r => {
  patternHeading('Avant'); patternBlock(r.before, true);
  patternHeading('Après'); patternBlock(r.after, true);
});
$('pat-array').onclick = () => runPattern('/api/pattern/array_ops', 'Array operators', r => {
  r.steps.forEach(s => {
    const row = el('div', 'pattern-step');
    row.appendChild(el('div', 'pattern-step-op', s.op));
    row.appendChild(el('div', 'pattern-step-val', JSON.stringify(s.tags)));
    patternOut.appendChild(row);
  });
});
$('pat-upsert').onclick = () => runPattern('/api/pattern/upsert', 'Upsert idempotent', r => {
  patternHeading('1er appel (doc inexistant → crée)'); patternBlock(r.first_call, true);
  patternHeading('2ème appel (même filtre → met à jour)'); patternBlock(r.second_call, true);
  patternHeading('Document final'); patternBlock(r.final, true);
});
$('pat-distinct').onclick = () => runPattern('/api/pattern/distinct', 'distinct()', r => {
  patternBlock('Categories uniques (' + r.latency_ms + ' ms) :', true);
  patternBlock(r.categories);
});
$('pat-operators').onclick = () => runPattern('/api/pattern/operators', 'Query operators combinés', r => {
  patternHeading('Requête'); patternBlock(r.query);
  patternHeading(r.matched_count + ' docs matchés');
  const table = el('table', 'pattern-table');
  const thead = el('thead'); const trh = el('tr'); ['name', 'role', 'city', 'age'].forEach(k => trh.appendChild(el('th', null, k))); thead.appendChild(trh); table.appendChild(thead);
  const tbody = el('tbody'); r.results.forEach(row => { const tr = el('tr'); tr.appendChild(el('td', null, row.name)); tr.appendChild(el('td', null, row.role)); tr.appendChild(el('td', null, row.city || '—')); tr.appendChild(el('td', null, row.age)); tbody.appendChild(tr); }); table.appendChild(tbody);
  patternOut.appendChild(table);
});

// ─── Latency budget ───
$('btn-latency').onclick = async (ev) => {
  const out = $('latency-out');
  while (out.firstChild) out.removeChild(out.firstChild);
  const btn = ev.currentTarget; btn.disabled = true; const oldT = btn.textContent; btn.textContent = '⏳ 45 RTT en cours…';
  out.appendChild(el('div', null, 'Mesure de 15 ping + 15 hello + 15 findOne…')).style.color = 'hsl(0,0%,50%)';
  try {
    const r = await api('/api/latency');
    while (out.firstChild) out.removeChild(out.firstChild);
    out.appendChild(el('div', 'pattern-narrative', r.narrative));

    const table = el('table', 'pattern-table');
    const thead = el('thead'); const trh = el('tr');
    ['Hop', 'min', 'p50', 'p95', 'max', 'avg'].forEach(k => trh.appendChild(el('th', null, k)));
    thead.appendChild(trh); table.appendChild(thead);
    const tbody = el('tbody');
    const rows = [
      { name: '🟢 test-client → FerretDB (ping)', d: r.hops.mongo_ping },
      { name: '🟢 test-client → FerretDB (hello)', d: r.hops.mongo_hello },
      { name: '🔵 test-client → FerretDB → PG (findOne by _id)', d: r.hops.full_findOne },
    ];
    rows.forEach(row => {
      const tr = el('tr');
      tr.appendChild(el('td', null, row.name));
      ['min', 'p50', 'p95', 'max', 'avg'].forEach(k => tr.appendChild(el('td', null, row.d[k] + ' ms')));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    out.appendChild(table);

    const summary = el('div', 'pattern-block tight');
    const pgHop = r.hops.pg_hop_estimate.avg;
    summary.textContent = '→ Hop FerretDB → PG addon estimé : ' + pgHop + ' ms (avg findOne - avg ping)';
    summary.style.color = '#86efac';
    out.appendChild(summary);

    addRow('latency', 'ping p50=' + r.hops.mongo_ping.p50 + 'ms · findOne p50=' + r.hops.full_findOne.p50 + 'ms · PG hop≈' + pgHop + 'ms', true);
  } catch (e) {
    while (out.firstChild) out.removeChild(out.firstChild);
    const errB = el('div', 'pattern-block'); errB.style.color = '#fca5a5'; errB.textContent = '❌ ' + e.message; out.appendChild(errB);
    addRow('latency', e.message, false);
  }
  btn.disabled = false; btn.textContent = oldT;
};

// ─── SQL underneath ───
const explainOut = $('explain-out');
async function runExplain(ep, label, btn) {
  while (explainOut.firstChild) explainOut.removeChild(explainOut.firstChild);
  btn.disabled = true; const oldT = btn.textContent; btn.textContent = '⏳ ' + (ep.includes('large') ? 'seed 10k docs…' : 'running…');
  const loading = el('div', null, 'Chargement…'); loading.style.color = 'hsl(0,0%,50%)'; explainOut.appendChild(loading);
  try {
    const r = await api(ep);
    explainOut.removeChild(loading);
    const narr = el('div', 'pattern-narrative', r.narrative); explainOut.appendChild(narr);
    // Highlight key metrics
    const nodeType = r.explain?.queryPlanner?.Plan?.['Node Type'] || '?';
    const summary = el('div', 'pattern-block tight');
    summary.textContent = '→ Node Type: ' + nodeType
      + ' · Plan Rows: ' + (r.explain?.queryPlanner?.Plan?.['Plan Rows'] || '?')
      + ' · Total Cost: ' + (r.explain?.queryPlanner?.Plan?.['Total Cost'] || '?')
      + (r.seed_ms ? '\nSeed: ' + r.seed_ms + ' ms · Explain: ' + r.explain_ms + ' ms' : '');
    summary.style.color = nodeType.toLowerCase().includes('index') ? '#86efac' : '#fbbf24';
    explainOut.appendChild(summary);
    const pre = el('pre', 'pattern-block', JSON.stringify(r.explain, null, 2)); pre.style.maxHeight = '500px'; explainOut.appendChild(pre);
    addRow('explain', label + ' → ' + nodeType + ' ✓', true);
  } catch (e) {
    explainOut.removeChild(loading);
    const errBlock = el('div', 'pattern-block'); errBlock.style.color = '#fca5a5'; errBlock.textContent = '❌ ' + e.message; explainOut.appendChild(errBlock);
    addRow('explain', label + ' ❌ ' + e.message, false);
  }
  btn.disabled = false; btn.textContent = oldT;
}
$('btn-explain-small').onclick = (ev) => runExplain('/api/explain', 'small (200)', ev.currentTarget);
$('btn-explain-large').onclick = (ev) => runExplain('/api/explain/large', 'large (10k, filter on field)', ev.currentTarget);
$('btn-explain-byid').onclick = (ev) => runExplain('/api/explain/by_id', 'by _id (10k)', ev.currentTarget);

// ─── Scorecard ───
function updateScorecard() {
  const cats = { crud: { ok: 0, total: 0 }, index: { ok: 0, total: 0 }, agg: { ok: 0, total: 0 }, adv: { ok: 0, total: 0 } };
  document.querySelectorAll('[data-cat]').forEach(p => {
    const cat = p.getAttribute('data-cat');
    if (!cats[cat]) return;
    cats[cat].total++;
    if (p.classList.contains('ok')) cats[cat].ok++;
  });
  let totalOk = 0, totalAll = 0;
  Object.entries(cats).forEach(([k, v]) => {
    totalOk += v.ok; totalAll += v.total;
    const pct = v.total ? Math.round((v.ok / v.total) * 100) : 0;
    const bar = $('bar-' + k); const val = $('val-' + k);
    if (bar) bar.style.width = pct + '%';
    if (val) val.textContent = v.ok + '/' + v.total;
  });
  $('score-big').textContent = totalOk + '/' + totalAll;
}

$('btn-compat').onclick = async () => {
  const b = $('btn-compat'); b.disabled = true; const oldT = b.textContent; b.textContent = 'Running…';
  document.querySelectorAll('[data-test]').forEach(el2 => { el2.className='compat-state pending'; el2.textContent='pending'; });
  updateScorecard();
  addRow('compat', 'Lancement de 14 tests de compatibilité Mongo réels…');
  const tests = [
    ['crud',            '/api/compat/crud'],
    ['index_simple',    '/api/compat/index_simple'],
    ['index_unique',    '/api/compat/index_unique'],
    ['index_compound',  '/api/compat/index_compound'],
    ['group_sum',       '/api/compat/group_sum'],
    ['group_avg',       '/api/compat/group_avg'],
    ['group_max_min',   '/api/compat/group_max_min'],
    ['sample',          '/api/compat/sample'],
    ['lookup',          '/api/compat/lookup'],
    ['regex',           '/api/compat/regex'],
    ['bulk_write',      '/api/compat/bulk_write'],
    ['text_search',     '/api/compat/text_search'],
    ['transaction',     '/api/compat/transaction'],
    ['change_stream',   '/api/compat/change_stream'],
  ];
  let nOk = 0, nKo = 0;
  for (const [name, ep] of tests) {
    try {
      const r = await fetch(ep);
      const j = await r.json();
      const isErr = j.error || j.codeName === 'NotImplemented' || j.ok === false;
      setCompat(name, !isErr, isErr ? (j.codeName || j.error || 'KO') : 'OK');
      addRow('compat', name + ' : ' + (isErr ? '❌ ' + (j.codeName || j.error || 'KO') : '✓ ok'), !isErr);
      if (isErr) nKo++; else nOk++;
    } catch(e) { setCompat(name, false, e.message); addRow('compat', name + ' : ❌ ' + e.message, false); nKo++; }
  }
  addRow('compat', 'Bilan : ' + nOk + ' ✓ · ' + nKo + ' ❌', nKo === 0);
  updateScorecard();
  b.disabled = false; b.textContent = oldT;
};
updateScorecard();

// ─── Comparaison v1 vs v2 ───
const COMPAT_TESTS_LIST = [
  ['crud', 'CRUD complet'],
  ['regex', '$regex'],
  ['bulk_write', 'bulkWrite'],
  ['index_simple', 'Index simple'],
  ['index_unique', 'Index unique'],
  ['index_compound', 'Index composé'],
  ['text_search', '$text search'],
  ['group_sum', '$group + $sum'],
  ['group_avg', '$group + $avg'],
  ['group_max_min', '$group + $max/$min'],
  ['sample', '$sample'],
  ['lookup', '$lookup (JOIN)'],
  ['transaction', 'Transactions multi-doc'],
  ['change_stream', 'Change streams'],
];

async function runOne(name, engine) {
  try {
    const r = await fetch('/api/compat/' + name + '?engine=' + engine);
    const j = await r.json();
    const isErr = j.error || j.codeName === 'NotImplemented' || j.ok === false;
    return { ok: !isErr, detail: isErr ? (j.codeName || j.error || 'KO') : 'OK' };
  } catch (e) { return { ok: false, detail: e.message }; }
}

const btnCompare = $('btn-compare');
if (btnCompare) btnCompare.onclick = async (ev) => {
  const btn = ev.currentTarget; btn.disabled = true; const oldT = btn.textContent; btn.textContent = '⏳ 28 tests…';
  const out = $('compare-out');
  out.style.display = 'block';
  while (out.firstChild) out.removeChild(out.firstChild);

  const summary = el('div', 'compare-summary');
  const s1 = el('div', 'compare-stat v1');
  s1.appendChild(el('div', 'compare-stat-big', '…')); s1.appendChild(el('div', 'compare-stat-label', 'FerretDB v1.24'));
  summary.appendChild(s1);
  const s2 = el('div', 'compare-stat v2');
  s2.appendChild(el('div', 'compare-stat-big', '…')); s2.appendChild(el('div', 'compare-stat-label', 'FerretDB v2.7'));
  summary.appendChild(s2);
  const sd = el('div', 'compare-stat delta');
  sd.appendChild(el('div', 'compare-stat-big', '…')); sd.appendChild(el('div', 'compare-stat-label', 'Gain v2'));
  summary.appendChild(sd);
  out.appendChild(summary);

  const table = el('table', 'compare-table');
  const thead = el('thead'); const trh = el('tr');
  trh.appendChild(el('th', null, 'Feature'));
  trh.appendChild(el('th', 'engine-col v1', 'FerretDB v1'));
  trh.appendChild(el('th', 'engine-col v2', 'FerretDB v2'));
  trh.appendChild(el('th', 'engine-col', 'Δ'));
  thead.appendChild(trh); table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);
  out.appendChild(table);

  let nV1Ok = 0, nV2Ok = 0, nGain = 0;
  for (const [name, label] of COMPAT_TESTS_LIST) {
    const tr = el('tr');
    tr.appendChild(el('td', 'feat', label));
    const tdV1 = el('td', 'cell', '…'); tr.appendChild(tdV1);
    const tdV2 = el('td', 'cell', '…'); tr.appendChild(tdV2);
    const tdDelta = el('td', 'cell', '—'); tr.appendChild(tdDelta);
    tbody.appendChild(tr);

    const [rv1, rv2] = await Promise.all([runOne(name, 'v1'), runOne(name, 'v2')]);
    tdV1.className = 'cell ' + (rv1.ok ? 'ok' : 'ko'); tdV1.textContent = rv1.ok ? '✓ OK' : '✗ ' + rv1.detail; tdV1.title = rv1.detail;
    tdV2.className = 'cell ' + (rv2.ok ? 'ok' : 'ko'); tdV2.textContent = rv2.ok ? '✓ OK' : '✗ ' + rv2.detail; tdV2.title = rv2.detail;
    if (rv1.ok) nV1Ok++;
    if (rv2.ok) nV2Ok++;
    if (!rv1.ok && rv2.ok) { tdDelta.className = 'cell gain'; tdDelta.textContent = '+ v2'; nGain++; }
    else if (rv1.ok && !rv2.ok) { tdDelta.className = 'cell ko'; tdDelta.textContent = '- v2'; }
    else { tdDelta.textContent = '='; }

    s1.children[0].textContent = nV1Ok + '/' + COMPAT_TESTS_LIST.length;
    s2.children[0].textContent = nV2Ok + '/' + COMPAT_TESTS_LIST.length;
    sd.children[0].textContent = (nGain > 0 ? '+' : '') + nGain;
  }

  addRow('compare', 'v1=' + nV1Ok + '/14 · v2=' + nV2Ok + '/14 · gains v2: ' + nGain, true);
  btn.disabled = false; btn.textContent = oldT;
};
