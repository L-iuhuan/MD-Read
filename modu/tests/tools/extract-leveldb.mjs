/**
 * leveldb 只读取证：抽出某个 key 的 **live 值**（如 `modu-recent`）。
 *
 * ⚠ 两条血泪纪律：
 * 1. **UTF-16LE 的奇偶偏移都要试**：只试偶数会把中文拆坏（`阶梯` → `6��h`）—— 那是**抽取假象**，不是产品缺陷。
 * 2. **leveldb 会保留被覆盖的历史版本**（compaction 前一直在）⇒ 直接扫原始字节可能读到**陈旧值**，
 *    把它当 live 值会造出**假警报**（真实翻车：按"取条数最多的一次命中"读出 10 条测试路径，
 *    据此判"用户数据被污染、要清理"，白做数轮；而**页面 live 值其实是 `[]`**）。
 *
 * **live 值规则（v3，必须出现在输出里）**：只看 **mtime 最新的活动文件**（通常是 `*.log`）里的
 * **最后一次命中**（leveldb 追加写 ⇒ 最后一条才是当前值）；其余命中归入 `historicalHits`。
 * ⚠ 有页面可读时**以页面 `localStorage` 为准**（见 `dump-origins.mjs --page`）；本工具用于"应用已停"时。
 *
 * 只读：不修改任何文件。应用**运行中** leveldb 被锁（读会 EBUSY）⇒ **先停应用**再跑。
 *
 * 用法：node tests/tools/extract-leveldb.mjs [--dir <leveldb>] [--key modu-recent] [--test-prefix <前缀>]
 *   --dir 省略时按 --profile-rel（默认 com.modu.reader/EBWebView/Default/Local Storage/leveldb）从 %LOCALAPPDATA% 拼
 *   --test-prefix 给定时额外输出 testEntries/otherEntries（判据 = 值以该前缀开头；**从不删**）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 在 `from` 之后按 UTF-16LE 两种偏移解析 JSON 数组；成功返回 {entries, encoding} */
export function parseArrayAfter(buf, from) {
  const region = buf.subarray(from, Math.min(buf.length, from + 12000));
  for (const parity of [0, 1]) {
    const text = region.subarray(parity).toString('utf16le');
    const start = text.indexOf('[');
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < Math.min(text.length, start + 20000); i += 1) {
      depth += text[i] === '[' ? 1 : text[i] === ']' ? -1 : 0;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1).replace(/\u0000/g, ''));
          if (Array.isArray(parsed)) return { entries: parsed.map(String), encoding: `utf16le(parity=${parity})` };
        } catch {
          /* 试下一种 */
        }
        break;
      }
    }
  }
  return null;
}

/**
 * 读 live 值：**mtime 最新的可解析文件里的最后一次命中**。
 * 返回里有 `rule` 与 `liveSource`，**读的人必须能看出这个值是怎么选出来的**。
 */
export function readLiveValue(dir, key) {
  if (!existsSync(dir)) return { error: `目录不存在: ${dir}` };
  const marker = Buffer.from(`\u0000\u0001${key}`, 'utf8');
  const hits = [];
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
      files.push({ file: f, error: `读失败:${error.code ?? 'unknown'}` }); // 应用运行中会 EBUSY
      continue;
    }
    files.push({ file: f, bytes: buf.length, mtime: st.mtime.toISOString() });
    let at = buf.indexOf(marker);
    while (at !== -1) {
      const parsed = parseArrayAfter(buf, at + marker.length);
      hits.push({ file: f, mtime: st.mtimeMs, offset: at, entries: parsed?.entries ?? null, encoding: parsed?.encoding ?? null });
      at = buf.indexOf(marker, at + marker.length);
    }
  }
  // 先按"文件 mtime 最新"，同文件内再按"偏移最大"（leveldb 追加写 ⇒ 最后一条 = 当前值）
  const ordered = hits.slice().sort((a, b) => b.mtime - a.mtime || b.offset - a.offset);
  const parsible = ordered.filter((h) => h.entries !== null);
  const live = parsible[0] ?? null;
  return {
    dir,
    key,
    rule: 'live 值 = **最新活动文件**（mtime 最新、且能解析）里的**最后一次命中**；其余命中为历史版本（compaction 前会一直留着）',
    liveSource:
      live === null
        ? null
        : { file: live.file, offset: live.offset, encoding: live.encoding, mtime: new Date(live.mtime).toISOString() },
    value: live === null ? null : live.entries,
    valueCount: live === null ? null : live.entries.length,
    historicalHits: parsible.length - (live === null ? 0 : 1),
    allHits: hits.length,
    files,
    encodingVerdict:
      live === null
        ? '未能解析出 live 值'
        : live.entries.some((e) => /\uFFFD/.test(e))
          ? '仍含替换字符 ⇒ 值可能真的坏了（需人看）'
          : '干净解码（UTF-16LE 对齐偏移）⇒ 之前的乱码是抽取假象、值本身没问题',
  };
}

/* ------------------------------ CLI ------------------------------ */
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
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
  const key = typeof args.key === 'string' ? args.key : 'modu-recent';
  const out = readLiveValue(dir, key);
  if (typeof args['test-prefix'] === 'string' && Array.isArray(out.value)) {
    const p = args['test-prefix'];
    out.testEntries = out.value.filter((e) => e.startsWith(p));
    out.otherEntries = out.value.filter((e) => !e.startsWith(p));
    out.testCount = out.testEntries.length;
    out.otherCount = out.otherEntries.length;
  }
  console.log(JSON.stringify(out, null, 1));
}
