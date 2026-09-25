/**
 * 全量标记扫描（取证，只读）：把 leveldb 里**所有** `\x00\x01<key>` 标记都列出来 —— **不做任何启发式筛选**，
 * 每个标记给：文件 / 偏移 / 文件 mtime / key / 后面跟的值（两种 UTF-16LE 偏移都试，能 JSON 解析就解析）。
 *
 * 为什么需要它（Lead 的假设，2026-09-23）：如果抽取器**靠"值里有没有路径"**去找命中，
 * 那么"值是 `[]`"的记录对它**根本不可见** ⇒ 它会报"最新的含路径命中"（旧值）而不是 live 值。
 * 本工具**只看 key 本身**，因此能回答"到底有没有一条 `modu-recent = []` 的记录、它在哪、比 10 条那条更晚吗"。
 *
 * 只读：不修改任何文件。应用运行中 leveldb 被锁 ⇒ **先停应用**。
 * 用法：node tests/tools/scan-markers.mjs [--dir <leveldb>] [--key modu-recent] [--all-keys]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}
const profileRel =
  typeof args['profile-rel'] === 'string'
    ? args['profile-rel']
    : path.join('com.modu.reader', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
const dir = typeof args.dir === 'string' ? args.dir : path.join(process.env.LOCALAPPDATA ?? os.homedir(), profileRel);
const onlyKey = typeof args.key === 'string' ? args.key : null;

if (!existsSync(dir)) {
  console.log(JSON.stringify({ error: `目录不存在: ${dir}` }, null, 1));
  process.exit(0);
}

/** 标记之后解析：先取 key（可打印 ASCII，最长 60），再按两种 UTF-16LE 偏移尝试 JSON */
function parseAfterMark(buf, at) {
  let keyEnd = at + 2;
  while (keyEnd < buf.length && keyEnd - (at + 2) < 60) {
    const b = buf[keyEnd];
    if (b < 0x20 || b > 0x7e) break;
    keyEnd += 1;
  }
  const key = buf.subarray(at + 2, keyEnd).toString('utf8');
  const region = buf.subarray(keyEnd, Math.min(buf.length, keyEnd + 12000));
  let value = null;
  let encoding = null;
  // ⚠ 两种**字节编码**都要试：纯 ASCII 值 Chromium 用 **1 字节（Latin1/UTF-8）** 存，
  //   含非 Latin1 字符（如中文路径）才用 **UTF-16LE**。只试 UTF-16LE 会让 `[]` 这类值**完全不可见** ✗
  for (const [dec, label] of [
    ['utf16le', 'utf16le'],
    ['latin1', 'latin1'],
  ]) {
    for (const parity of dec === 'utf16le' ? [0, 1] : [0]) {
      const text = region.subarray(parity).toString(dec);
      const start = text.indexOf('[');
      if (start === -1) continue;
      let depth = 0;
      for (let i = start; i < Math.min(text.length, start + 20000); i += 1) {
        depth += text[i] === '[' ? 1 : text[i] === ']' ? -1 : 0;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1).replace(/\u0000/g, ''));
            if (Array.isArray(parsed)) {
              value = parsed.map(String);
              encoding = `${label}(parity=${parity})`;
            }
          } catch {
            /* 继续 */
          }
          break;
        }
      }
      if (value !== null) break;
    }
    if (value !== null) break;
  }
  return { key, value, encoding };
}

const markers = [];
const files = [];
for (const f of readdirSync(dir)) {
  const full = path.join(dir, f);
  let st;
  let buf;
  try {
    st = statSync(full);
    if (!st.isFile()) continue;
    buf = readFileSync(full);
  } catch (error) {
    files.push({ file: f, error: `读失败:${error.code ?? 'unknown'}` });
    continue;
  }
  files.push({ file: f, bytes: buf.length, mtime: new Date(st.mtimeMs).toISOString() });
  for (let at = buf.indexOf(Buffer.from([0x00, 0x01])); at !== -1; at = buf.indexOf(Buffer.from([0x00, 0x01]), at + 1)) {
    const parsed = parseAfterMark(buf, at);
    if (parsed.key === '') continue; // 不是"键"标记
    if (onlyKey !== null && parsed.key !== onlyKey) continue;
    markers.push({
      file: f,
      offset: at,
      mtime: new Date(st.mtimeMs).toISOString(),
      key: parsed.key,
      encoding: parsed.encoding,
      value: parsed.value,
      valueCount: parsed.value === null ? null : parsed.value.length,
    });
  }
}

// 按 key 汇总：每次命中都给（**不做"取哪一条"的选择**，让人自己看）
const byKey = new Map();
for (const m of markers) {
  const list = byKey.get(m.key) ?? [];
  list.push(m);
  byKey.set(m.key, list);
}
const summary = [...byKey.entries()].map(([key, list]) => ({
  key,
  hits: list.length,
  files: [...new Set(list.map((m) => m.file))],
  // 时间序：同文件按偏移、跨文件按 mtime
  timeline: list
    .slice()
    .sort((a, b) => (a.mtime === b.mtime ? a.offset - b.offset : a.mtime < b.mtime ? -1 : 1))
    .map((m) => ({ file: m.file, offset: m.offset, mtime: m.mtime, valueCount: m.valueCount, isEmpty: m.value !== null && m.value.length === 0 })),
}));

const target = onlyKey ?? 'modu-recent';
const targetHits = markers.filter((m) => m.key === target).sort((a, b) => (a.mtime === b.mtime ? a.offset - b.offset : a.mtime < b.mtime ? -1 : 1));
console.log(
  JSON.stringify(
    {
      dir,
      key: target,
      files,
      /** 你要的判据：**有没有一条值恰好是 `[]` 的命中**？它在时间序里的位置？ */
      emptyValueHits: targetHits.filter((m) => m.value !== null && m.value.length === 0),
      nonEmptyValueHits: targetHits.filter((m) => m.value !== null && m.value.length > 0),
      timeline: targetHits.map((m) => ({ file: m.file, offset: m.offset, mtime: m.mtime, valueCount: m.valueCount })),
      lastTimelineEntry: targetHits[targetHits.length - 1] ?? null,
      allKeysSummary: summary,
    },
    null,
    1,
  ),
);
