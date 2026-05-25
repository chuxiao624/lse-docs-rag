import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DASHSCOPE_API_KEY) {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch { }
}

const {
  openDb,
  search,
  fetchDocs,
  getDoc,
  listMembers,
  listNamespaces,
  listClasses,
} = await import('./search.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'index.sqlite');

const db = openDb(DB_PATH);

const indexMeta = db.prepare('SELECT key, value FROM index_meta').all().reduce((acc, r) => {
  acc[r.key] = r.value;
  return acc;
}, {});

function formatSearchHit(hit, doc) {
  const sigs = doc.signatures ? JSON.parse(doc.signatures) : [];
  const aliases = doc.aliases ? JSON.parse(doc.aliases) : [];
  const headings = doc.heading_path ? JSON.parse(doc.heading_path) : [];
  const lines = [];
  lines.push(`### ${doc.id}`);
  lines.push(`- kind: ${doc.kind}`);
  if (doc.class) lines.push(`- class: ${doc.class}`);
  if (doc.receiver) lines.push(`- receiver: \`${doc.receiver}\``);
  if (sigs.length) lines.push(`- signatures: ${sigs.map((s) => `\`${s.raw}\``).join(' / ')}`);
  if (aliases.length) lines.push(`- aliases: ${aliases.join(', ')}`);
  if (doc.version_added) lines.push(`- version_added: ${doc.version_added}`);
  if (doc.deprecated) lines.push(`- ⚠️ DEPRECATED`);
  lines.push(`- source: ${doc.source_file}:${doc.source_line}`);
  if (headings.length) lines.push(`- path: ${headings.join(' / ')}`);
  if (hit.rerank_score != null) lines.push(`- relevance: ${hit.rerank_score.toFixed(3)}`);
  return lines.join('\n');
}

function formatFullDoc(doc) {
  const sigs = doc.signatures ? JSON.parse(doc.signatures) : [];
  const aliases = doc.aliases ? JSON.parse(doc.aliases) : [];
  const headings = doc.heading_path ? JSON.parse(doc.heading_path) : [];
  const lines = [];
  lines.push(`# ${doc.id}`);
  lines.push('');
  lines.push(`**Kind:** ${doc.kind}`);
  if (doc.namespace) lines.push(`**Namespace:** ${doc.namespace}`);
  if (doc.class) lines.push(`**Class:** ${doc.class}`);
  if (doc.member) lines.push(`**Member:** ${doc.member}`);
  if (doc.receiver) lines.push(`**Receiver:** \`${doc.receiver}\``);
  if (sigs.length) lines.push(`**Signatures:** ${sigs.map((s) => `\`${s.raw}\``).join(' / ')}`);
  if (aliases.length) lines.push(`**Aliases:** ${aliases.join(', ')}`);
  if (doc.version_added) lines.push(`**Version Added:** ${doc.version_added}`);
  if (doc.deprecated) lines.push(`**⚠️ DEPRECATED**`);
  lines.push(`**Source:** ${doc.source_file}:${doc.source_line}`);
  if (headings.length) lines.push(`**Heading Path:** ${headings.join(' / ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(doc.content);
  return lines.join('\n');
}

const server = new McpServer({
  name: 'lse-docs-rag',
  version: '0.1.0',
});

server.tool(
  'search_api',
  `搜索 LegacyScriptEngine (LLSE) 插件 API 文档。需要查找 LLSE API 用于编写插件时使用——返回真实的 API 签名而不是凭记忆编造。查询可中英文混用。结果包含完整签名和源文件位置。在编写涉及不完全确定的 LLSE API 的代码之前，请务必调用本工具。`,
  {
    query: z.string().describe('自然语言描述或部分 API 名称。示例："传送玩家"、"pl.kick"、"how to listen for player join"、"NBT to JSON"。'),
    namespace: z
      .enum(['GameAPI', 'EventAPI', 'DataAPI', 'GuiAPI', 'NbtAPI', 'ScriptAPI', 'SystemAPI', 'apis', 'tutorials'])
      .optional()
      .describe('可选过滤器：限定到某一个命名空间。'),
    kind: z
      .enum(['method', 'property', 'event', 'enum', 'enum_value', 'property_table', 'concept', 'guide'])
      .optional()
      .describe('可选过滤器：限定到某一类实体。'),
    class: z.string().optional().describe('可选过滤器：限定到命名空间下的某一个类（例如 "Player"、"BinaryStream"）。'),
    limit: z.number().int().min(1).max(20).optional().describe('返回的结果数量。默认 5。'),
    mode: z
      .enum(['rerank', 'hybrid', 'bm25'])
      .optional()
      .describe('检索模式。"rerank"（默认，质量最优）会调用 embedding 和 rerank 两次 API。"hybrid" 跳过 rerank（1 次 API 调用）。"bm25" 仅关键词检索（零 API 调用）。'),
  },
  async (args) => {
    const limit = args.limit ?? 5;
    const result = await search(db, args.query, {
      recall: 30,
      rerankPool: Math.max(20, limit * 4),
      finalK: limit,
      namespace: args.namespace,
      class: args.class,
      kind: args.kind,
      mode: args.mode,
    });
    if (result.hits.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No API entities matched the query "${args.query}". Try rewording, or use list_members to browse a namespace.`,
          },
        ],
      };
    }
    const docs = fetchDocs(db, result.hits.map((h) => h.id));
    const blocks = result.hits.map((h, i) => formatSearchHit(h, docs[i]));
    const cacheTag = result.cache_hit ? ' · cache hit' : '';
    const header = `Found ${result.hits.length} result(s) for "${args.query}" [mode=${result.mode}${cacheTag}]. Use get_api with an id to fetch the full doc and example code.`;
    return {
      content: [{ type: 'text', text: header + '\n\n' + blocks.join('\n\n---\n\n') }],
    };
  }
);

server.tool(
  'get_api',
  `通过规范 ID 获取某个 API 实体的完整文档（包括参数、返回值类型，以及 JavaScript/Lua 示例代码）。当你打算实际使用某个 API 时，请在 search_api 之后调用本工具——以便在编写插件代码前确认精确的签名、参数并查看使用示例。`,
  {
    id: z.string().describe('规范的 API ID，例如 "GameAPI.Player.teleport" 或 "EventAPI.PlayerEvents.onJoin"。这些 ID 来自 search_api 的结果。'),
  },
  async (args) => {
    const doc = getDoc(db, args.id);
    if (!doc) {
      return {
        content: [
          { type: 'text', text: `No API entity with id "${args.id}" exists. Use search_api to discover valid IDs.` },
        ],
      };
    }
    return { content: [{ type: 'text', text: formatFullDoc(doc) }] };
  }
);

server.tool(
  'list_members',
  `枚举某个类或命名空间下的 API 成员（方法、属性、事件）。当你需要发现可用 API 时使用——例如「Player 有哪些方法？」或「可以监听哪些事件？」。返回带签名的精简列表，不含完整文档。`,
  {
    namespace: z
      .enum(['GameAPI', 'EventAPI', 'DataAPI', 'GuiAPI', 'NbtAPI', 'ScriptAPI', 'SystemAPI'])
      .describe('必填的命名空间，例如 "GameAPI"。'),
    class: z
      .string()
      .optional()
      .describe('可选：命名空间下的某个类。示例："Player"、"Entity"、"BinaryStream"、"KVDatabase"、"PlayerEvents"。'),
    kind: z
      .enum(['method', 'property', 'event', 'enum', 'enum_value'])
      .optional()
      .describe('可选：按类型过滤。'),
    limit: z.number().int().min(1).max(500).optional().describe('返回的最大成员数。默认 200。'),
  },
  async (args) => {
    const rows = listMembers(db, {
      namespace: args.namespace,
      className: args.class,
      kind: args.kind,
      limit: args.limit ?? 200,
    });
    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No members found for namespace=${args.namespace}${args.class ? `, class=${args.class}` : ''}.`,
          },
        ],
      };
    }
    const grouped = new Map();
    for (const r of rows) {
      const key = `${r.namespace}.${r.class || '_'}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }
    const blocks = [];
    for (const [key, items] of grouped) {
      const lines = [`## ${key} (${items.length})`];
      for (const r of items) {
        const sigs = r.signatures ? JSON.parse(r.signatures) : [];
        const sig = sigs[0]?.raw || r.member || '(no signature)';
        const dep = r.deprecated ? ' !' : '';
        const ver = r.version_added ? ` (since ${r.version_added})` : '';
        lines.push(`- \`${r.id}\` [${r.kind}] \`${sig}\`${ver}${dep}`);
      }
      blocks.push(lines.join('\n'));
    }
    return { content: [{ type: 'text', text: blocks.join('\n\n') }] };
  }
);

server.tool(
  'list_namespaces',
  `列出 LLSE API 的顶级命名空间（GameAPI、EventAPI 等）及其类列表。当你不知道从何入手时，用本工具对 API 全貌做一个快速了解。`,
  {},
  async () => {
    const namespaces = listNamespaces(db);
    const blocks = [];
    for (const ns of namespaces) {
      const classes = listClasses(db, ns);
      blocks.push(`## ${ns}\nClasses: ${classes.length ? classes.join(', ') : '(none)'}`);
    }
    blocks.push(
      `\n---\nIndex built ${indexMeta.built_at} via ${indexMeta.embed_model} (${indexMeta.embed_dim}-d) — ${indexMeta.chunk_count} chunks.`
    );
    return { content: [{ type: 'text', text: blocks.join('\n\n') }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
