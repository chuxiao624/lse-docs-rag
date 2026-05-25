import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DOCS_ROOT) {
  try {
    process.loadEnvFile(path.join(__dirname, '..', '.env'));
  } catch {}
}

const DOCS_ROOT = process.env.DOCS_ROOT ? path.resolve(process.env.DOCS_ROOT) : null;
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'chunks.jsonl');

if (!DOCS_ROOT || !fs.existsSync(DOCS_ROOT)) {
  console.error('ERROR: DOCS_ROOT not set or does not exist.');
  console.error('       Point it at a checkout of LiteLDev/LegacyScriptEngine docs');
  console.error('       (the directory containing apis/, tutorials/, faq.zh.md, index.zh.md).');
  process.exit(1);
}

const INCLUDE_DIRS = ['apis', 'tutorials'];
const INCLUDE_ROOT_FILES = ['faq.zh.md', 'index.zh.md'];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && p.endsWith('.md')) yield p;
  }
}

function listMarkdownFiles() {
  const all = [];
  for (const sub of INCLUDE_DIRS) {
    const dir = path.join(DOCS_ROOT, sub);
    if (fs.existsSync(dir)) all.push(...walk(dir));
  }
  for (const name of INCLUDE_ROOT_FILES) {
    const p = path.join(DOCS_ROOT, name);
    if (fs.existsSync(p)) all.push(p);
  }
  return all.sort();
}

function toRel(absPath) {
  return path.relative(DOCS_ROOT, absPath).replace(/\\/g, '/');
}

function findHeadings(lines) {
  const out = [];
  let inFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1];
      } else if (line.includes(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2].trim(), line: i });
  }
  return out;
}

function buildSections(headings, lines) {
  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const next = headings[i + 1];
    const start = h.line + 1;
    const end = next ? next.line : lines.length;
    const contentLines = lines.slice(start, end);
    sections.push({
      ...h,
      contentLines,
      content: contentLines.join('\n'),
    });
  }
  return sections;
}

function buildHeadingPath(sections, idx) {
  const stack = [];
  for (let i = 0; i <= idx; i++) {
    const h = sections[i];
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    stack.push(h);
  }
  return stack.map((s) => stripEmoji(s.title));
}

function stripEmoji(s) {
  return s
    .replace(
      /[\u{200D}\u{FE00}-\u{FE0F}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F100}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{2640}-\u{2642}\u{1F004}\u{1F0CF}]/gu,
      ''
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
}

function isMostlyEmpty(text, minLen = 30) {
  const cleaned = stripCodeBlocks(text)
    .replace(/!!!.*$/gm, '')
    .replace(/^\s*[->!|]/gm, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/\s+/g, '');
  return cleaned.length < minLen;
}

function parseRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
}

function extractTables(lines) {
  const tables = [];
  let i = 0;
  while (i < lines.length) {
    const isPipeLine = /^\s*\|/.test(lines[i]);
    const nextIsSep = i + 1 < lines.length && /^\s*\|?\s*:?-+/.test(lines[i + 1]);
    if (isPipeLine && nextIsSep) {
      const headers = parseRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        rows.push(parseRow(lines[j]));
        j++;
      }
      tables.push({ headers, rows, startLine: i, endLine: j - 1 });
      i = j;
    } else {
      i++;
    }
  }
  return tables;
}

// `pl.kick([msg])` 或 `pl.kick([msg])` -> 描述
const SIG_INLINE_RE = /^`((?:new\s+)?[A-Za-z_][\w]*(?:\.[\w]+)*\s*\([^`]*\))`\s*(?:(?:->|→)\s*(.+))?\s*$/;
// [JavaScript] `new BinaryStream()`  /  [Lua] `BinaryStream()`
const SIG_LANG_RE = /^\[(JavaScript|Lua|JS|Python|Node\.js)\]\s*`([^`]+)`\s*$/i;
// Packet.zh.md 里用的三反引号内联写法
const SIG_LANG_TRIPLE_RE = /^\[(JavaScript|Lua|JS|Python|Node\.js)\]\s*```([^`]+)```\s*$/i;

function matchSig(line) {
  const t = line.replace(/\s+$/, '');
  let m;
  if ((m = t.match(SIG_INLINE_RE))) return { raw: m[1].trim(), lang: null, desc: m[2] || null };
  if ((m = t.match(SIG_LANG_RE))) return { raw: m[2].trim(), lang: m[1], desc: null };
  if ((m = t.match(SIG_LANG_TRIPLE_RE))) return { raw: m[2].trim(), lang: m[1], desc: null };
  return null;
}

// 在标题下扫描前若干行非空内容；签名通常紧凑排列
function extractSignatures(lines) {
  const sigs = [];
  let scanned = 0;
  let lastSigLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') {
      if (sigs.length > 0 && i - lastSigLine > 2) break;
      continue;
    }
    scanned++;
    if (sigs.length === 0 && scanned > 6) break;
    const m = matchSig(trimmed);
    if (m) {
      sigs.push(m);
      lastSigLine = i;
    } else if (sigs.length > 0) {
      break;
    }
  }
  return sigs;
}

function extractMemberName(sig) {
  const r = sig.raw;
  const newMatch = r.match(/^new\s+([A-Za-z_][\w]*)/);
  if (newMatch) return newMatch[1];
  const m = r.match(/^([A-Za-z_][\w]*(?:\.[\w]+)*)\s*\(/);
  if (!m) return null;
  const parts = m[1].split('.');
  return parts[parts.length - 1];
}

function extractReceiver(sig) {
  if (/^new\s+/.test(sig.raw)) return null;
  const m = sig.raw.match(/^([A-Za-z_][\w]*)\./);
  return m ? m[1] : null;
}

function uniqueAliases(sigs) {
  const names = new Set();
  for (const s of sigs) {
    const n = extractMemberName(s);
    if (n) names.add(n);
  }
  return [...names];
}

const VERSION_INLINE_RE = /(?:在\s*)?(\d+\.\d+(?:\.\d+)?)\s*(?:时)?(?:被)?(?:加入|新增|添加|引入)/;
const DEPRECATED_RE = /已在\s*(\d+\.\d+(?:\.\d+)?)\s*中废弃|已经?废弃|deprecated/i;

function extractVersionAdded(text) {
  const m = text.match(VERSION_INLINE_RE);
  return m ? m[1] : null;
}

function detectFileDeprecated(text) {
  const head = text.slice(0, 600);
  return DEPRECATED_RE.test(head);
}

function inferNamespace(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'apis' && parts.length >= 3) return parts[1];
  if (parts[0] === 'apis') return 'apis';
  return parts[0];
}

function inferFileClass(rel) {
  const base = path.basename(rel).replace(/\.zh\.md$/, '').replace(/\.md$/, '');
  return base;
}

function classify(section) {
  const titleClean = stripEmoji(section.title);

  if (/^目录\s*$/.test(titleClean)) return { kind: 'skip' };

  const eventMatch = section.title.match(/`"([A-Za-z_][\w]*)"`/);
  if (eventMatch) return { kind: 'event', eventName: eventMatch[1] };

  const isProperty = /属性|成员/.test(titleClean);
  const isEnum = /枚举/.test(titleClean);
  if (isProperty || isEnum) {
    const tables = extractTables(section.contentLines);
    if (tables.length > 0) {
      return { kind: isEnum ? 'enum' : 'property_table', table: tables[0] };
    }
  }

  const sigs = extractSignatures(section.contentLines);
  if (sigs.length > 0) return { kind: 'method', signatures: sigs };

  return { kind: 'concept' };
}

class IdMinter {
  constructor() {
    this.seen = new Map();
  }
  mint(parts) {
    const id = parts.filter(Boolean).join('.');
    const n = (this.seen.get(id) || 0) + 1;
    this.seen.set(id, n);
    return n === 1 ? id : `${id}__${n}`;
  }
}

function memberIdSegment(name) {
  if (!name) return null;
  if (/^[A-Za-z_][\w]*$/.test(name)) return name;
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_|_$/g, '');
  return cleaned || null;
}

function makeBaseChunk({ kind, id, namespace, className, member, fileRel, line, headingPath, content, deprecated }) {
  const versionAdded = extractVersionAdded(content);
  const embedSrc = `${headingPath.join(' / ')}\n\n${stripCodeBlocks(content).trim()}`;
  return {
    id,
    kind,
    namespace,
    class: className || null,
    member: member || null,
    aliases: [],
    signatures: [],
    receiver: null,
    version_added: versionAdded,
    deprecated: !!deprecated,
    source_file: fileRel,
    source_line: line + 1,
    heading_path: headingPath,
    content,
    content_for_embed: embedSrc.trim(),
  };
}

function emitMethod(section, info, fileMeta, headingPath, ids) {
  const { signatures } = info;
  const primary = signatures[0];
  const memberName = extractMemberName(primary) || memberIdSegment(section.title) || `m${section.line}`;
  const aliases = uniqueAliases(signatures).filter((n) => n !== memberName);
  const receiver = extractReceiver(primary);
  const className = resolveClassFor(headingPath, fileMeta);

  const id = ids.mint([fileMeta.namespace, className, memberIdSegment(memberName) || `m${section.line}`]);
  const content = `### ${section.title}\n\n${section.content.trim()}`;
  const chunk = makeBaseChunk({
    kind: 'method',
    id,
    namespace: fileMeta.namespace,
    className,
    member: memberName,
    fileRel: fileMeta.fileRel,
    line: section.line,
    headingPath,
    content,
    deprecated: fileMeta.deprecated,
  });
  chunk.aliases = aliases;
  chunk.signatures = signatures.map((s) => ({ raw: s.raw, lang: s.lang || null }));
  chunk.receiver = receiver;
  return [chunk];
}

function emitEvent(section, info, fileMeta, headingPath, ids) {
  const eventName = info.eventName;
  const className = resolveClassFor(headingPath, fileMeta);
  const id = ids.mint([fileMeta.namespace, className, eventName]);
  const content = `### ${section.title}\n\n${section.content.trim()}`;
  const chunk = makeBaseChunk({
    kind: 'event',
    id,
    namespace: fileMeta.namespace,
    className,
    member: eventName,
    fileRel: fileMeta.fileRel,
    line: section.line,
    headingPath,
    content,
    deprecated: fileMeta.deprecated,
  });
  chunk.signatures = [{ raw: `"${eventName}"`, lang: null }];
  return [chunk];
}

function emitPropertyTable(section, info, fileMeta, headingPath, ids) {
  const { table } = info;
  const out = [];
  const className = resolveClassFor(headingPath, fileMeta);
  const content = `### ${section.title}\n\n${section.content.trim()}`;
  const tableId = ids.mint([fileMeta.namespace, className, 'properties']);
  const tableChunk = makeBaseChunk({
    kind: 'property_table',
    id: tableId,
    namespace: fileMeta.namespace,
    className,
    member: null,
    fileRel: fileMeta.fileRel,
    line: section.line,
    headingPath,
    content,
    deprecated: fileMeta.deprecated,
  });
  // 表级 version_added 在每行各有 version 的情况下无意义
  tableChunk.version_added = null;
  out.push(tableChunk);

  for (const row of table.rows) {
    if (row.length < 2) continue;
    const nameCell = row[0];
    const descCell = row[1] || '';
    const typeCell = row[2] || '';
    const propMatch = nameCell.match(/([A-Za-z_][\w]*)\s*$/);
    if (!propMatch) continue;
    const propName = propMatch[1];
    const receiver = (nameCell.match(/^([A-Za-z_][\w]*)\./) || [])[1] || null;
    const versionMatch = nameCell.match(/(\d+\.\d+(?:\.\d+)?)/);

    const rowContent =
      `属性: \`${nameCell}\`\n` +
      `类型: ${typeCell}\n` +
      `含义: ${descCell}\n` +
      `来自: ${fileMeta.namespace}.${className} (${headingPath.join(' / ')})`;

    const rowId = ids.mint([fileMeta.namespace, className, memberIdSegment(propName) || `p${section.line}`]);
    const rowChunk = makeBaseChunk({
      kind: 'property',
      id: rowId,
      namespace: fileMeta.namespace,
      className,
      member: propName,
      fileRel: fileMeta.fileRel,
      line: section.line,
      headingPath,
      content: rowContent,
      deprecated: fileMeta.deprecated,
    });
    rowChunk.receiver = receiver;
    rowChunk.signatures = [{ raw: nameCell, lang: null }];
    if (versionMatch) rowChunk.version_added = versionMatch[1];
    else rowChunk.version_added = null;
    out.push(rowChunk);
  }
  return out;
}

function emitEnum(section, info, fileMeta, headingPath, ids) {
  const { table } = info;
  const out = [];
  const className = resolveClassFor(headingPath, fileMeta);
  const enumNameMatch = section.title.match(/([A-Z][a-zA-Z0-9]+)/);
  const enumName = enumNameMatch ? enumNameMatch[1] : memberIdSegment(stripEmoji(section.title)) || `e${section.line}`;

  const content = `### ${section.title}\n\n${section.content.trim()}`;
  const enumId = ids.mint([fileMeta.namespace, className, enumName]);
  out.push(
    makeBaseChunk({
      kind: 'enum',
      id: enumId,
      namespace: fileMeta.namespace,
      className,
      member: enumName,
      fileRel: fileMeta.fileRel,
      line: section.line,
      headingPath,
      content,
      deprecated: fileMeta.deprecated,
    })
  );

  for (const row of table.rows) {
    const cell = row[0];
    if (!cell) continue;
    const m = cell.match(/`?([A-Za-z_][\w]*\.[A-Za-z_][\w]*)`?/);
    if (!m) continue;
    const fullName = m[1];
    const [enumPart, valuePart] = fullName.split('.');
    const valueContent =
      `枚举值: \`${fullName}\`\n` +
      `所属枚举: ${enumPart}\n` +
      `来自: ${fileMeta.namespace}.${className}`;
    const valueId = ids.mint([fileMeta.namespace, className, enumPart, valuePart]);
    const valueChunk = makeBaseChunk({
      kind: 'enum_value',
      id: valueId,
      namespace: fileMeta.namespace,
      className,
      member: valuePart,
      fileRel: fileMeta.fileRel,
      line: section.line,
      headingPath,
      content: valueContent,
      deprecated: fileMeta.deprecated,
    });
    valueChunk.signatures = [{ raw: fullName, lang: null }];
    out.push(valueChunk);
  }
  return out;
}

function emitConcept(section, fileMeta, headingPath, ids, isGuide) {
  if (isMostlyEmpty(section.content, 60)) return [];
  const className = resolveClassFor(headingPath, fileMeta);
  const slug = memberIdSegment(stripEmoji(section.title)) || `h${section.line}`;
  const content = `${'#'.repeat(section.level)} ${section.title}\n\n${section.content.trim()}`;
  const id = ids.mint([fileMeta.namespace, className, slug]);
  return [
    makeBaseChunk({
      kind: isGuide ? 'guide' : 'concept',
      id,
      namespace: fileMeta.namespace,
      className,
      member: null,
      fileRel: fileMeta.fileRel,
      line: section.line,
      headingPath,
      content,
      deprecated: fileMeta.deprecated,
    }),
  ];
}

const GUIDE_FILES = new Set([
  'apis/README.zh.md',
  'apis/LanguageSupport.zh.md',
  'apis/EventAPI/Listen.zh.md',
  'apis/ScriptAPI/ScriptHelp.zh.md',
  'faq.zh.md',
  'index.zh.md',
]);

// 一份 .md 同时记录多个类时用：第一条 `contains` 能在 heading_path 任意位置命中的规则胜出
const MULTI_CLASS_RULES = {
  'apis/GameAPI/Packet.zh.md': [
    { contains: '二进制流', class: 'BinaryStream' },
    { contains: '数据包', class: 'Packet' },
  ],
  'apis/DataAPI/DataBase.zh.md': [
    { contains: '键 - 值', class: 'KVDatabase' },
    { contains: 'NoSQL', class: 'KVDatabase' },
    { contains: 'SQL数据库', class: 'DBSession' },
    { contains: 'SQL', class: 'DBSession' },
  ],
};

function resolveClassFor(headingPath, fileMeta) {
  const rules = MULTI_CLASS_RULES[fileMeta.fileRel];
  if (rules) {
    const joined = headingPath.join(' / ');
    for (const r of rules) {
      if (joined.includes(r.contains)) return r.class;
    }
  }
  return fileMeta.fileClass;
}

function isGuideFile(rel) {
  if (GUIDE_FILES.has(rel)) return true;
  if (rel.startsWith('tutorials/')) return true;
  return false;
}

function processFile(absPath) {
  const rel = toRel(absPath);
  const text = fs.readFileSync(absPath, 'utf-8');
  const lines = text.split(/\r?\n/);
  const headings = findHeadings(lines);
  const sections = buildSections(headings, lines);

  const fileMeta = {
    fileRel: rel,
    namespace: inferNamespace(rel),
    fileClass: inferFileClass(rel),
    deprecated: detectFileDeprecated(text),
  };
  const isGuide = isGuideFile(rel);
  const ids = new IdMinter();
  const chunks = [];

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const info = classify(sec);
    const headingPath = buildHeadingPath(sections, i);

    switch (info.kind) {
      case 'skip':
        break;
      case 'event':
        chunks.push(...emitEvent(sec, info, fileMeta, headingPath, ids));
        break;
      case 'property_table':
        chunks.push(...emitPropertyTable(sec, info, fileMeta, headingPath, ids));
        break;
      case 'enum':
        chunks.push(...emitEnum(sec, info, fileMeta, headingPath, ids));
        break;
      case 'method':
        chunks.push(...emitMethod(sec, info, fileMeta, headingPath, ids));
        break;
      case 'concept':
      default:
        chunks.push(...emitConcept(sec, fileMeta, headingPath, ids, isGuide));
        break;
    }
  }

  return chunks;
}

function main() {
  const files = listMarkdownFiles();
  const all = [];
  const stats = {};
  for (const file of files) {
    const chunks = processFile(file);
    for (const c of chunks) {
      stats[c.kind] = (stats[c.kind] || 0) + 1;
      all.push(c);
    }
  }
  fs.writeFileSync(OUTPUT_PATH, all.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf-8');
  console.log(`Files processed: ${files.length}`);
  console.log(`Total chunks:    ${all.length}`);
  console.log('Breakdown by kind:');
  for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${v}`);
  }
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main();
