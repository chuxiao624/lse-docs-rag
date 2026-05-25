import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const EMBED_MODEL = process.env.DASHSCOPE_EMBED_MODEL || 'text-embedding-v4';
const RERANK_MODEL = process.env.DASHSCOPE_RERANK_MODEL || 'qwen3-rerank';
const EMBED_DIM = Number(process.env.DASHSCOPE_EMBED_DIM || 2048);
const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const RERANK_URL = 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank';

if (!DASHSCOPE_API_KEY) {
  throw new Error('DASHSCOPE_API_KEY not set in environment');
}

export function openDb(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  return db;
}

async function embedQuery(text) {
  const resp = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: [text],
      dimensions: EMBED_DIM,
      encoding_format: 'float',
    }),
  });
  if (!resp.ok) throw new Error(`Embed ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  return json.data[0].embedding;
}

async function rerank(query, documents, topN) {
  const resp = await fetch(RERANK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: RERANK_MODEL,
      input: { query, documents },
      parameters: { return_documents: false, top_n: topN },
    }),
  });
  if (!resp.ok) throw new Error(`Rerank ${resp.status}: ${await resp.text()}`);
  const json = await resp.json();
  return json.output.results.map((r) => ({ index: r.index, score: r.relevance_score }));
}

function buildFtsQuery(text) {
  const cleaned = text.replace(/["*+\-:()^]/g, ' ').trim();
  if (!cleaned) return null;
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  // 纯汉字 token 用前缀短语匹配以支持子串
  const finalTokens = tokens.map((t) => {
    if (/^[\u4e00-\u9fa5]+$/.test(t)) {
      return `"${t}"*`;
    }
    return `"${t.replace(/"/g, '""')}"`;
  });
  return finalTokens.join(' OR ');
}

function searchBM25(db, query, limit, filters) {
  const ftsq = buildFtsQuery(query);
  if (!ftsq) return [];
  let sql = `
    SELECT documents_fts.id AS id, bm25(documents_fts) AS bm25_score
    FROM documents_fts
    JOIN documents ON documents.id = documents_fts.id
    WHERE documents_fts MATCH ?
  `;
  const params = [ftsq];
  if (filters?.namespace) {
    sql += ` AND documents.namespace = ?`;
    params.push(filters.namespace);
  }
  if (filters?.class) {
    sql += ` AND documents.class = ?`;
    params.push(filters.class);
  }
  if (filters?.kind) {
    sql += ` AND documents.kind = ?`;
    params.push(filters.kind);
  }
  sql += ` ORDER BY bm25_score LIMIT ?`;
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map((r, i) => ({ id: r.id, rank: i + 1, source: 'bm25' }));
}

function searchVector(db, queryVec, limit, filters) {
  // sqlite-vec 不支持 MATCH 配合 JOIN，多取一些再做过滤
  const fetchN = filters?.namespace || filters?.class || filters?.kind ? limit * 5 : limit;
  const rows = db
    .prepare(`
      SELECT id, distance
      FROM vec_documents
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `)
    .all(Float32Array.from(queryVec), fetchN);
  if (!filters?.namespace && !filters?.class && !filters?.kind) {
    return rows.map((r, i) => ({ id: r.id, rank: i + 1, source: 'vec' }));
  }
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const metaRows = db
    .prepare(`SELECT id, namespace, class, kind FROM documents WHERE id IN (${placeholders})`)
    .all(...ids);
  const meta = new Map(metaRows.map((r) => [r.id, r]));
  const filtered = rows
    .filter((r) => {
      const m = meta.get(r.id);
      if (!m) return false;
      if (filters.namespace && m.namespace !== filters.namespace) return false;
      if (filters.class && m.class !== filters.class) return false;
      if (filters.kind && m.kind !== filters.kind) return false;
      return true;
    })
    .slice(0, limit);
  return filtered.map((r, i) => ({ id: r.id, rank: i + 1, source: 'vec' }));
}

function rrf(rankings, k = 60) {
  const scores = new Map();
  const sources = new Map();
  for (const ranking of rankings) {
    for (const item of ranking) {
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + item.rank));
      const srcs = sources.get(item.id) || new Set();
      srcs.add(item.source);
      sources.set(item.id, srcs);
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, sources: [...sources.get(id)] }))
    .sort((a, b) => b.score - a.score);
}

const CACHE_SIZE = Number(process.env.RAG_CACHE_SIZE || 200);
const CACHE_TOP_N = 20;

class LRU {
  constructor(max) {
    this.max = max;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return undefined;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.max) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, val);
  }
  clear() {
    this.cache.clear();
  }
  get size() {
    return this.cache.size;
  }
}

const searchCache = new LRU(CACHE_SIZE);
const stats = { hits: 0, misses: 0, api_calls: 0 };

export function getCacheStats() {
  return { ...stats, size: searchCache.size, max: CACHE_SIZE };
}

export function clearCache() {
  searchCache.clear();
}

async function searchUncached(db, query, opts) {
  const mode = opts.mode || 'rerank';
  const recall = opts.recall ?? 30;
  const rerankPool = opts.rerankPool ?? 20;
  const filters = {
    namespace: opts.namespace,
    class: opts.class,
    kind: opts.kind,
  };

  const bm = searchBM25(db, query, recall, filters);

  if (mode === 'bm25') {
    return {
      hits: bm.slice(0, CACHE_TOP_N).map((f) => ({
        id: f.id,
        score: 1 / (60 + f.rank),
        sources: [f.source],
        rerank_score: null,
      })),
      apis: 0,
    };
  }

  const queryVec = await embedQuery(query);
  const vec = searchVector(db, queryVec, recall, filters);
  const fused = rrf([bm, vec]);

  if (mode === 'hybrid' || fused.length === 0) {
    return {
      hits: fused.slice(0, CACHE_TOP_N).map((f) => ({ ...f, rerank_score: null })),
      apis: 1,
    };
  }

  const candidates = fused.slice(0, rerankPool);
  const docs = fetchDocs(db, candidates.map((c) => c.id));
  const documents = docs.map((d) => {
    const headings = d.heading_path ? JSON.parse(d.heading_path).join(' / ') : '';
    return `${headings}\n${d.content_for_embed || ''}`;
  });
  const reranked = await rerank(query, documents, Math.min(CACHE_TOP_N, candidates.length));

  return {
    hits: reranked.map((r) => ({
      id: candidates[r.index].id,
      score: candidates[r.index].score,
      sources: candidates[r.index].sources,
      rerank_score: r.score,
    })),
    apis: 2,
  };
}

export async function search(db, query, opts = {}) {
  const mode = opts.mode || 'rerank';
  const finalK = opts.finalK ?? 5;
  const fresh = opts.fresh === true;

  const cacheKey = JSON.stringify({
    q: query,
    mode,
    ns: opts.namespace || null,
    cls: opts.class || null,
    kind: opts.kind || null,
  });

  if (!fresh) {
    const cached = searchCache.get(cacheKey);
    if (cached) {
      stats.hits++;
      return {
        hits: cached.hits.slice(0, finalK),
        mode,
        cache_hit: true,
        cache_age_ms: Date.now() - cached.timestamp,
        apis_called: 0,
        elapsed_ms: Date.now() - (opts._t0 ?? Date.now()),
      };
    }
  }

  stats.misses++;
  const t0 = Date.now();
  const { hits, apis } = await searchUncached(db, query, opts);
  stats.api_calls += apis;

  searchCache.set(cacheKey, { hits, timestamp: Date.now() });

  return {
    hits: hits.slice(0, finalK),
    mode,
    cache_hit: false,
    cache_age_ms: 0,
    apis_called: apis,
    elapsed_ms: Date.now() - t0,
  };
}

export function fetchDocs(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM documents WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function getDoc(db, id) {
  const row = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
  return row || null;
}

export function listMembers(db, { namespace, className, kind, limit = 200 } = {}) {
  let sql = `SELECT id, kind, namespace, class, member, signatures, version_added, deprecated, heading_path
             FROM documents WHERE 1=1`;
  const params = [];
  if (namespace) {
    sql += ` AND namespace = ?`;
    params.push(namespace);
  }
  if (className) {
    sql += ` AND class = ?`;
    params.push(className);
  }
  if (kind) {
    sql += ` AND kind = ?`;
    params.push(kind);
  }
  sql += ` ORDER BY namespace, class, kind, member LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}

export function listNamespaces(db) {
  return db
    .prepare(`SELECT DISTINCT namespace FROM documents WHERE namespace IS NOT NULL ORDER BY namespace`)
    .all()
    .map((r) => r.namespace);
}

export function listClasses(db, namespace) {
  return db
    .prepare(`SELECT DISTINCT class FROM documents WHERE namespace = ? AND class IS NOT NULL ORDER BY class`)
    .all(namespace)
    .map((r) => r.class);
}
