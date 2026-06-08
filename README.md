# docs-rag

给 [LegacyScriptEngine](https://github.com/LiteLDev/LegacyScriptEngine)(LLSE)的中文 API 文档套一层 RAG + MCP 让 Claude Code / Cursor 之类的 LLM 写 LLSE 插件时能查到真实 API 而不是瞎编

## 注意 !!!!!

**这是个练手项目 没什么实用价值 , 你完全可以使用context7 MCP 代替 或者让模型自己grep**

## 灵感 API 💡 API: https://docs.chuxiao.top/idea/save 

LLSE 全部 API 文档加起来也就 百来个 chunk 几 MB markdown对这种体量的语料:

- `grep -rn` 几乎瞬间返回所有结果
- 整个 `apis/` 目录塞进 LLM 上下文都还有富余
- 直接给 LLM 一份目录结构 + 文件清单让它自己 `Read` 也够用

上这套 BM25 + 向量召回 + RRF + qwen3-rerank 纯粹是想把 RAG 链路自己写一遍练手 切块 建索引 混合检索 rerank 缓存 MCP 暴露 配套调试 UI 整个流程跑通如果你在找一个真正解决问题的 LLSE 助手 挂个 grep 工具给模型用就行了 不需要这一套

所以请把它当成：

- RAG 链路的最小可工作样例
- 怎么把检索结果通过 MCP 暴露给 Claude Code 之类客户端的参考

仅此而已

## 工作原理

```
DOCS_ROOT/**/*.md  →  chunker  →  build_index  →  MCP / Web UI / probe
                                                              
```

每次查询：

```
query  →  BM25 (FTS5) top-30
       →  向量 (sqlite-vec, DashScope text-embedding-v4 / 2048-d) top-30
       →  RRF 融合 top-20
       →  qwen3-rerank top-K
```

## 三种检索模式

| 模式 | 流程 | API 调用 |
|---|---|---|
| `rerank`(默认) | embed + bm25 + RRF + qwen3-rerank | 2 次 |
| `hybrid` | embed + bm25 + RRF | 1 次 |
| `bm25` | 纯 FTS5 关键词 | 0 次 |

MCP / Web UI 都暴露了 `mode` 参数现场切换`(query, mode, 过滤器)` 命中会落进内存 LRU(默认 200 条) 二次调用 ~1ms 重启失效

## 准备

- Node.js 20.12+(用到 `process.loadEnvFile`)
- 阿里云百炼 API key
- 一份 LLSE 文档源码 

拉 LLSE 文档

配置：

```bash
cp .env.example .env
# 在 .env 里填 DASHSCOPE_API_KEY 以及 DOCS_ROOT=/some/where/docs
npm install
```

## 构建索引

```bash
npm run chunk     # 切分 markdown 到 data/chunks.jsonl
npm run build     # 跑 embedding 构建 data/index.sqlite
```

## 用法

### 作为 MCP server 给 Claude Code 用

```bash
claude mcp add -s user lse-docs node /绝对路径/docs-rag/src/mcp_server.js
```

重启客户端后会有 4 个工具：

- `search_api(query, namespace?, kind?, class?, limit?, mode?)`
- `get_api(id)`
- `list_members(namespace, class?, kind?)`
- `list_namespaces()`

### Web UI(调试用)

```bash
npm run web         # 默认 http://localhost:5173
```

带过滤器 mode 切换 cache 命中状态 API 调用计数

### 命令行 probe

```bash
npm run probe              # 三模式各跑一遍预设的 12 个查询
node tools/probe.js bm25   # 只跑某一种
```

改 `tools/probe.js` 里的 `queries` 数组测自己的 query

### MCP 烟测

```bash
npm run test:mcp           # 不开 Claude Code 直接当客户端连本地 server 跑一遍工具
```

## 文档更新后重建

```bash
npm run chunk && npm run build
```

## 致谢

- LLSE 文档原文来自 [LiteLDev/LegacyScriptEngine](https://github.com/LiteLDev/LegacyScriptEngine)
- Embedding / rerank 用了阿里云百炼的 `text-embedding-v4` 和 `qwen3-rerank`
- 检索栈：`better-sqlite3` + `sqlite-vec` + FTS5
