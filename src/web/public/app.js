const form = document.getElementById('searchForm');
const queryEl = document.getElementById('query');
const searchBtn = document.getElementById('searchBtn');
const namespaceEl = document.getElementById('namespace');
const classEl = document.getElementById('class');
const kindEl = document.getElementById('kind');
const modeEl = document.getElementById('mode');
const freshEl = document.getElementById('fresh');
const limitEl = document.getElementById('limit');
const clearCacheBtn = document.getElementById('clearCache');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const headerMetaEl = document.getElementById('headerMeta');

let namespacesData = [];

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function loadNamespaces() {
  try {
    const r = await fetch('/api/namespaces');
    const j = await r.json();
    namespacesData = j.namespaces || [];
    for (const ns of namespacesData) {
      const opt = document.createElement('option');
      opt.value = ns.namespace;
      opt.textContent = ns.namespace;
      namespaceEl.appendChild(opt);
    }
    const totalClasses = namespacesData.reduce((s, n) => s + n.classes.length, 0);
    headerMetaEl.textContent = `${namespacesData.length} namespaces · ${totalClasses} classes`;
  } catch (e) {
    headerMetaEl.textContent = 'failed to load namespaces';
  }
}

namespaceEl.addEventListener('change', () => {
  classEl.innerHTML = '<option value="">All</option>';
  const ns = namespacesData.find((n) => n.namespace === namespaceEl.value);
  if (ns) {
    for (const c of ns.classes) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      classEl.appendChild(opt);
    }
  }
});

function renderHit(hit, idx) {
  const d = hit.doc;
  if (!d) return '';
  const sigs = (d.signatures || []).map((s) => s.raw).join('\n');
  const aliases = (d.aliases || []).join(', ');
  const headings = (d.heading_path || []).join(' › ');
  const rerank =
    hit.rerank_score != null
      ? `rerank ${hit.rerank_score.toFixed(3)}`
      : `rrf ${hit.score.toFixed(4)}`;
  const sources = (hit.sources || []).join('+');
  const verTag = d.version_added ? `<span class="tag version">since ${escapeHtml(d.version_added)}</span>` : '';
  const depTag = d.deprecated ? `<span class="tag deprecated">⚠ DEPRECATED</span>` : '';
  return `
    <div class="card" data-id="${escapeHtml(d.id)}">
      <div class="card-head">
        <div>
          <div class="card-id"><span class="card-rank">#${idx + 1}</span>${escapeHtml(d.id)}</div>
          <div class="card-meta">
            <span class="tag kind">${escapeHtml(d.kind)}</span>${verTag}${depTag}
            · ${escapeHtml(rerank)} · via ${escapeHtml(sources)}
            · ${escapeHtml(d.source_file)}:${d.source_line}
          </div>
        </div>
      </div>
      ${sigs ? `<div class="card-sigs">${escapeHtml(sigs)}</div>` : ''}
      ${headings ? `<div class="card-heading">${escapeHtml(headings)}</div>` : ''}
      ${aliases ? `<div class="card-aliases">aliases: <code>${escapeHtml(aliases)}</code></div>` : ''}
      <div class="card-expand" data-action="toggle">▾ Show full doc</div>
      <pre class="card-content hidden">${escapeHtml(d.content)}</pre>
    </div>
  `;
}

resultsEl.addEventListener('click', (e) => {
  if (e.target.matches('[data-action="toggle"]')) {
    const card = e.target.closest('.card');
    const content = card.querySelector('.card-content');
    const hidden = content.classList.toggle('hidden');
    e.target.textContent = hidden ? '▾ Show full doc' : '▴ Hide';
  }
});

let pendingController = null;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = queryEl.value.trim();
  if (!query) return;

  if (pendingController) pendingController.abort();
  pendingController = new AbortController();

  searchBtn.disabled = true;
  statusEl.innerHTML = '<span class="spinner"></span>Searching...';
  resultsEl.innerHTML = '';

  try {
    const body = {
      query,
      namespace: namespaceEl.value || undefined,
      class: classEl.value || undefined,
      kind: kindEl.value || undefined,
      mode: modeEl.value,
      fresh: freshEl.checked,
      limit: Number(limitEl.value) || 10,
    };
    const r = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: pendingController.signal,
    });
    const j = await r.json();
    if (!r.ok) {
      statusEl.textContent = 'Error: ' + (j.error || r.status);
      return;
    }
    const modeLabel = {
      rerank: 'embed + bm25 → RRF → qwen3-rerank',
      hybrid: 'embed + bm25 → RRF',
      bm25: 'bm25 only (no API)',
    }[j.mode] || j.mode;
    const cachePill = j.cache_hit
      ? `<span class="pill hit">CACHE HIT</span><span style="opacity:0.7">age ${(j.cache_age_ms / 1000).toFixed(1)}s</span>`
      : `<span class="pill miss">CACHE MISS</span><span style="opacity:0.7">${j.apis_called} API call${j.apis_called === 1 ? '' : 's'}</span>`;
    const modePill = `<span class="pill mode">${escapeHtml(j.mode)}</span>`;
    statusEl.innerHTML = `${modePill}${cachePill} · ${j.hits.length} result${j.hits.length === 1 ? '' : 's'} · ${j.elapsed_ms}ms · ${escapeHtml(modeLabel)}`;
    if (j.hits.length === 0) {
      resultsEl.innerHTML = '<div class="empty">No matches. Try rewording the query or relax filters.</div>';
    } else {
      resultsEl.innerHTML = j.hits.map(renderHit).join('');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      statusEl.textContent = 'Error: ' + err.message;
    }
  } finally {
    searchBtn.disabled = false;
  }
});

clearCacheBtn.addEventListener('click', async () => {
  clearCacheBtn.disabled = true;
  try {
    const r = await fetch('/api/cache/clear', { method: 'POST' });
    const j = await r.json();
    statusEl.innerHTML = `<span class="pill hit">CACHE CLEARED</span>size now ${j.stats.size}/${j.stats.max} · lifetime hits ${j.stats.hits}, misses ${j.stats.misses}`;
  } finally {
    clearCacheBtn.disabled = false;
  }
});

loadNamespaces();
