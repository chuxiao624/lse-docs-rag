import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHUNKS_PATH = path.join(__dirname, '..', 'data', 'chunks.jsonl');
const DB_PATH = path.join(__dirname, '..', 'data', 'index.sqlite');

if (!process.env.DASHSCOPE_API_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {}
}

const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const EMBED_MODEL = process.env.DASHSCOPE_EMBED_MODEL || 'text-embedding-v4';
const EMBED_DIM = Number(process.env.DASHSCOPE_EMBED_DIM || 2048);
const EMBED_BATCH = 10; // DashScope v4 上限
const EMBED_CONCURRENCY = 4;
const EMBED_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';

if (!DASHSCOPE_API_KEY) {
  console.error('ERROR: DASHSCOPE_API_KEY not set in environment or rag/.env');
  process.exit(1);
}

async function embedBatch(texts, attempt = 1) {
  const resp = await fetch(EMBED_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: texts,
      dimensions: EMBED_DIM,
      encoding_format: 'float',
    }),
  });

  if (resp.status === 429 || resp.status >= 500) {
    if (attempt >= 5) {
      const body = await resp.text();
      throw new Error(`Embed API ${resp.status} after ${attempt} attempts: ${body}`);
    }
    const wait = 1000 * Math.pow(2, attempt - 1);
    await new Promise((r) => setTimeout(r, wait));
    return embedBatch(texts, attempt + 1);
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Embed API ${resp.status}: ${body}`);
  }

  const json = await resp.json();
  return json.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  const total = items.length;
  const printProgress = () => {
    process.stdout.write(`\r  Progress: ${completed}/${total} batches`);
  };
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i], i);
        completed++;
        printProgress();
      }
    })
  );
  process.stdout.write('\n');
  return results;
}

function buildSearchableText(chunk) {
  const parts = [];
  if (chunk.signatures?.length) parts.push(chunk.signatures.map((s) => s.raw).join(' '));
  if (chunk.aliases?.length) parts.push(chunk.aliases.join(' '));
  if (chunk.heading_path?.length) parts.push(chunk.heading_path.join(' '));
  parts.push(chunk.content_for_embed || '');
  return parts.join('\n');
}

function buildEmbedSource(chunk) {
  const parts = [];
  if (chunk.heading_path?.length) parts.push(chunk.heading_path.join(' / '));
  if (chunk.signatures?.length) parts.push(chunk.signatures.map((s) => s.raw).join('\n'));
  parts.push(chunk.content_for_embed || '');
  // 截到 6000 字符以下，远低于 v4 的 8192 token
  return parts.join('\n\n').slice(0, 6000);
}

function createSchema(db, dim) {
  db.exec(`
    DROP TABLE IF EXISTS documents;
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      namespace TEXT,
      class TEXT,
      member TEXT,
      aliases TEXT,
      signatures TEXT,
      receiver TEXT,
      version_added TEXT,
      deprecated INTEGER,
      source_file TEXT,
      source_line INTEGER,
      heading_path TEXT,
      content TEXT,
      content_for_embed TEXT
    );
    CREATE INDEX idx_documents_namespace ON documents(namespace);
    CREATE INDEX idx_documents_class ON documents(class);
    CREATE INDEX idx_documents_kind ON documents(kind);
  `);

  db.exec(`
    DROP TABLE IF EXISTS documents_fts;
    CREATE VIRTUAL TABLE documents_fts USING fts5(
      id UNINDEXED,
      searchable_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  db.exec(`
    DROP TABLE IF EXISTS vec_documents;
    CREATE VIRTUAL TABLE vec_documents USING vec0(
      id TEXT PRIMARY KEY,
      embedding FLOAT[${dim}]
    );
  `);

  db.exec(`
    DROP TABLE IF EXISTS index_meta;
    CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

async function main() {
  const startTime = Date.now();

  console.log(`Reading chunks from ${path.relative(process.cwd(), CHUNKS_PATH)}...`);
  const chunks = fs.readFileSync(CHUNKS_PATH, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  console.log(`  ${chunks.length} chunks loaded`);

  console.log(`Opening ${path.relative(process.cwd(), DB_PATH)}...`);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v, vec_version() AS vv').get();
  console.log(`  SQLite ${sqliteVersion.v}, sqlite-vec ${sqliteVersion.vv}`);

  console.log(`Creating schema (embed dim = ${EMBED_DIM})...`);
  createSchema(db, EMBED_DIM);

  console.log('Inserting documents + FTS rows...');
  const insertDoc = db.prepare(`
    INSERT INTO documents (
      id, kind, namespace, class, member, aliases, signatures, receiver,
      version_added, deprecated, source_file, source_line, heading_path,
      content, content_for_embed
    ) VALUES (
      @id, @kind, @namespace, @class, @member, @aliases, @signatures, @receiver,
      @version_added, @deprecated, @source_file, @source_line, @heading_path,
      @content, @content_for_embed
    )
  `);
  const insertFts = db.prepare('INSERT INTO documents_fts (id, searchable_text) VALUES (?, ?)');
  const docTx = db.transaction(() => {
    for (const c of chunks) {
      insertDoc.run({
        id: c.id,
        kind: c.kind,
        namespace: c.namespace ?? null,
        class: c.class ?? null,
        member: c.member ?? null,
        aliases: JSON.stringify(c.aliases || []),
        signatures: JSON.stringify(c.signatures || []),
        receiver: c.receiver ?? null,
        version_added: c.version_added ?? null,
        deprecated: c.deprecated ? 1 : 0,
        source_file: c.source_file ?? null,
        source_line: c.source_line ?? null,
        heading_path: JSON.stringify(c.heading_path || []),
        content: c.content,
        content_for_embed: c.content_for_embed,
      });
      insertFts.run(c.id, buildSearchableText(c));
    }
  });
  docTx();
  console.log(`  ${chunks.length} rows in documents + documents_fts`);

  console.log(`Embedding via DashScope ${EMBED_MODEL} (${EMBED_DIM}-d)...`);
  const sources = chunks.map(buildEmbedSource);
  const batches = [];
  for (let i = 0; i < sources.length; i += EMBED_BATCH) {
    batches.push({
      texts: sources.slice(i, i + EMBED_BATCH),
      ids: chunks.slice(i, i + EMBED_BATCH).map((c) => c.id),
    });
  }
  console.log(`  ${batches.length} batches × size ${EMBED_BATCH}, concurrency ${EMBED_CONCURRENCY}`);

  const t0 = Date.now();
  const results = await mapConcurrent(batches, EMBED_CONCURRENCY, async (batch) => {
    const vecs = await embedBatch(batch.texts);
    return batch.ids.map((id, i) => ({ id, vec: vecs[i] }));
  });
  console.log(`  Embedding wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log('Writing vec_documents...');
  const insertVec = db.prepare('INSERT INTO vec_documents (id, embedding) VALUES (?, ?)');
  const vecTx = db.transaction(() => {
    for (const batch of results) {
      for (const { id, vec } of batch) {
        insertVec.run(id, Float32Array.from(vec));
      }
    }
  });
  vecTx();

  const meta = db.prepare('INSERT INTO index_meta (key, value) VALUES (?, ?)');
  meta.run('embed_model', EMBED_MODEL);
  meta.run('embed_dim', String(EMBED_DIM));
  meta.run('chunk_count', String(chunks.length));
  meta.run('built_at', new Date().toISOString());

  const docCount = db.prepare('SELECT COUNT(*) AS c FROM documents').get().c;
  const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM documents_fts').get().c;
  const vecCount = db.prepare('SELECT COUNT(*) AS c FROM vec_documents').get().c;
  console.log(`\nFinal counts:`);
  console.log(`  documents:      ${docCount}`);
  console.log(`  documents_fts:  ${ftsCount}`);
  console.log(`  vec_documents:  ${vecCount}`);
  console.log(`  total wall:     ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`  DB file:        ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(2)} MB`);

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
