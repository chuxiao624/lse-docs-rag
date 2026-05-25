import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DASHSCOPE_API_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {}
}

const { openDb, search, fetchDocs, getCacheStats } = await import('../src/search.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'index.sqlite');

async function runOne(db, q, mode) {
  const result = await search(db, q, { recall: 30, rerankPool: 20, finalK: 5, mode });
  const docs = fetchDocs(db, result.hits.map((h) => h.id));
  console.log(
    `[${mode.padEnd(7)}] ${result.cache_hit ? 'CACHE' : ' API '} · ${String(result.elapsed_ms).padStart(4)}ms · ${result.apis_called} api call(s)`
  );
  for (let i = 0; i < result.hits.length; i++) {
    const h = result.hits[i];
    const d = docs[i];
    if (!d) continue;
    const summary = (d.content || '')
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 1)
      .join(' ');
    const rerankStr = h.rerank_score != null ? `rerank=${h.rerank_score.toFixed(3)}` : `rrf=${h.score.toFixed(4)}`;
    console.log(
      `   ${i + 1}. [${d.kind.padEnd(8)}] ${d.id.padEnd(40)} ${rerankStr} via ${h.sources.join('+')}`
    );
    console.log(`      ${summary.slice(0, 110)}`);
  }
}

async function main() {
  const db = openDb(DB_PATH);
  const cliMode = process.argv[2];

  const queries = [
    '怎么传送玩家',
    'pl.inWater',
    '监听玩家进入服务器',
    '二进制流写整数',
    '判断玩家是否在水中',
    '怎么发送消息给玩家',
    '踢出玩家',
    'kick player',
    '设置玩家显示标题',
    '玩家死亡事件',
    '创建一个表单',
    'NBT 转 JSON',
  ];

  const modes = cliMode && cliMode !== 'compare' ? [cliMode] : ['bm25', 'hybrid', 'rerank'];

  for (const q of queries) {
    console.log('\n========================================');
    console.log(`Query: ${q}`);
    console.log('----------------------------------------');
    for (const mode of modes) {
      await runOne(db, q, mode);
    }
  }

  console.log('\n----------------------------------------');
  console.log('缓存状态:', getCacheStats());

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
