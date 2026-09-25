/**
 * leveldb 只读取证：从 WebView2 的 `Local Storage/leveldb` 里抽出某个 key 的**值**（如 `modu-recent`）。
 *
 * ⚠ 关键教训（2026-09-23 实测）：WebView2 存非 Latin1 字符串用 **UTF-16LE**，且**起始偏移可能是奇数**；
 *  只按偶数偏移解一次会把中文拆坏（`阶梯` → `6��h`）—— 那是**抽取假象**，不是产品缺陷。
 *  v2 做法：key 之后 12KB 窗口，**奇偶偏移都试**，按"能 JSON.parse 成数组"判定，并统计替换字符数。
 *
 * 只读：不修改任何文件。应用**运行中** leveldb 被锁（读会 EBUSY）⇒ **先停应用**再跑本工具。
 *
 * 用法：node tests/tools/extract-leveldb.mjs --dir <leveldb 目录> [--key modu-recent] [--delete-prefix <路径前缀>]
 *   --dir   可给绝对路径；或用 --profile-rel 从 %LOCALAPPDATA% 拼（默认 com.modu.reader/EBWebView/Default/Local Storage/leveldb）
 *   --delete-prefix 给定时，额外输出"删除集/保留集"（判据 = 值以该前缀开头；调用方自行决定是否删除，本工具**从不删**）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}
const profileRel = typeof args['profile-rel'] === 'string' ? args['profile-rel'] : path.join('com.modu.reader', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
const dir = typeof args.dir === 'string' ? args.dir : path.join(process.env.LOCALAPPDATA ?? os.homedir(), profileRel);
const key = typeof args.key === 'string' ? args.key : 'modu-recent';

if (!existsSync(dir)) {
  console.log(JSON.stringify({ error: `目录不存在: ${dir}`, hint: '应用运行中 leveldb 会被锁；路径可用 --dir 指定' }, null, 1));
  process.exit(0);
}

function tryParseArray(text) {
  const start = text.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < Math.min(text.length, start + 20000); i += 1) {
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        for (const cand of [text.slice(start, i + 1), text.slice(start, i + 1).replace(/\u0000/g, '')]) {
          try {
            const parsed = JSON.parse(cand);
            if (Array.isArray(parsed)) return parsed.map(String);
          } catch {
            /* 试下一种 */
          }
        }
        return null;
      }
    }
  }
  return null;
}

const out = { dir, key, perFile: [], best: null };
for (const f of readdirSync(dir).filter((x) => !statSync(path.join(dir, x)).isDirectory())) {
  const buf = readFileSync(path.join(dir, f));
  const keyAt = buf.indexOf(Buffer.from(key, 'utf8'));
  if (keyAt === -1) continue;
  const region = buf.subarray(keyAt, Math.min(buf.length, keyAt + 12000));
  const attempts = [];
  for (const parity of [0, 1]) {
    const text = region.subarray(parity).toString('utf16le');
    const entries = tryParseArray(text);
    attempts.push({ enc: `utf16le(parity=${parity})`, parsed: entries !== null, count: entries?.length ?? 0, replacementChars: (text.match(/\uFFFD/g) ?? []).length, cjkChars: (text.match(/[\u4e00-\u9fff]/g) ?? []).length });
    if (entries !== null && out.best === null) out.best = { file: f, enc: `utf16le(parity=${parity})`, entries };
  }
  const utf8Text = region.toString('utf8');
  attempts.push({ enc: 'utf8', parsed: tryParseArray(utf8Text) !== null, count: tryParseArray(utf8Text)?.length ?? 0, replacementChars: (utf8Text.match(/\uFFFD/g) ?? []).length, cjkChars: (utf8Text.match(/[\u4e00-\u9fff]/g) ?? []).length });
  out.perFile.push({ file: f, bytes: buf.length, attempts });
}

if (out.best !== null) {
  out.value = out.best.entries;
  out.valueCount = out.best.entries.length;
  out.encodingVerdict =
    out.best.entries.some((e) => /\uFFFD/.test(e))
      ? '仍含替换字符 ⇒ 值可能真的坏了（需人看）'
      : '干净解码（UTF-16LE 对齐偏移）⇒ 之前的乱码是抽取假象、值本身没问题';
  if (typeof args['delete-prefix'] === 'string') {
    const p = args['delete-prefix'];
    out.deleteSet = out.best.entries.filter((e) => e.startsWith(p));
    out.keepSet = out.best.entries.filter((e) => !e.startsWith(p));
    out.deleteCount = out.deleteSet.length;
    out.keepCount = out.keepSet.length;
  }
}
console.log(JSON.stringify(out, null, 1));
