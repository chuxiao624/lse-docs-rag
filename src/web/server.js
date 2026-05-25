import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DASHSCOPE_API_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '..', '.env'));
  } catch {

  }
}

const { openDb, search, getDoc, listNamespaces, listClasses, getCacheStats, clearCache } = await import('../search.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'index.sqlite');
const PORT = Number(process.env.WEB_PORT || 5173);

const db = openDb(DB_PATH);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const cleaned = path.normalize(url).replace(/^[/\\]+/, '');
  const filePath = path.join(PUBLIC_DIR, cleaned);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

function safeJson(s, fallback) {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function projectDoc(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    kind: doc.kind,
    namespace: doc.namespace,
    class: doc.class,
    member: doc.member,
    receiver: doc.receiver,
    aliases: safeJson(doc.aliases, []),
    signatures: safeJson(doc.signatures, []),
    version_added: doc.version_added,
    deprecated: !!doc.deprecated,
    source_file: doc.source_file,
    source_line: doc.source_line,
    heading_path: safeJson(doc.heading_path, []),
    content: doc.content,
  };
}

async function handleApi(req, res, url) {
  try {
    if (url.pathname === '/api/search' && req.method === 'POST') {
      const body = await readBody(req);
      const { query, namespace, kind, class: cls, limit, mode, fresh } = body;
      if (!query) return sendJSON(res, 400, { error: 'query is required' });
      const finalK = Math.min(20, Math.max(1, limit || 10));
      const result = await search(db, query, {
        recall: 30,
        rerankPool: Math.max(20, finalK * 4),
        finalK,
        mode: mode || 'rerank',
        fresh: fresh === true,
        namespace: namespace || undefined,
        class: cls || undefined,
        kind: kind || undefined,
      });
      const enriched = result.hits.map((h) => ({ ...h, doc: projectDoc(getDoc(db, h.id)) }));
      return sendJSON(res, 200, {
        hits: enriched,
        elapsed_ms: result.elapsed_ms,
        mode: result.mode,
        cache_hit: result.cache_hit,
        cache_age_ms: result.cache_age_ms,
        apis_called: result.apis_called,
      });
    }

    if (url.pathname === '/api/cache/stats' && req.method === 'GET') {
      return sendJSON(res, 200, getCacheStats());
    }

    if (url.pathname === '/api/cache/clear' && req.method === 'POST') {
      clearCache();
      return sendJSON(res, 200, { ok: true, stats: getCacheStats() });
    }

    if (url.pathname.startsWith('/api/doc/') && req.method === 'GET') {
      const id = decodeURIComponent(url.pathname.slice('/api/doc/'.length));
      const doc = getDoc(db, id);
      if (!doc) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, { doc: projectDoc(doc) });
    }

    if (url.pathname === '/api/namespaces' && req.method === 'GET') {
      const namespaces = listNamespaces(db).map((ns) => ({
        namespace: ns,
        classes: listClasses(db, ns),
      }));
      return sendJSON(res, 200, { namespaces });
    }

    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: e.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`LSE docs RAG · Web UI ready at http://localhost:${PORT}`);
});
