/**
 * 全量标记扫描（取证，只读）：把 leveldb 里**所有** `\x00\x01<key>` 标记都列出来 —— **不做任何启发式筛选**，
 * 每个标记给：文件 / 偏移 / 文件 mtime / key / 后面跟的值（两种 UTF-16LE 偏移都试，能 JSON 解析就解析，
 * **解析不成 JSON 就退回原始字符串** —— forensics 的用途是看值，不是只看 JSON 数组）。
 *
 * 为什么需要它（Lead 的假设，2026-09-23）：如果抽取器**靠"值里有没有路径"**去找命中，
 * 那么"值是 `[]`"的记录对它**根本不可见** ⇒ 它会报"最新的含路径命中"（旧值）而不是 live 值。
 * 本工具**只看 key 本身**，因此能回答"到底有没有一条 `modu-recent = []` 的记录、它在哪、比 10 条那条更晚吗"。
 *
 * ⚠ **两种记录布局（2026-09-23 只读 dump 实测，另见 `AGENTS.md`）**：
 *   · **布局 A（`.ldb` SSTable 落盘）**：`\x00\x01` + **键** + **值**（值首字节是编码标签
 *     `0x00` = Latin1 / `0x01` = UTF-16，**都不可打印**）⇒「按可打印 ASCII 找键尾」**停在对的位置** ⇒ 本来读得到 ✓
 *   · **布局 B（`.log` WriteBatch 未落盘）**：`… + 键 + varint(值长) + 值` ⇒ 值长低字节若**可打印**
 *     （`0x20–0x7e` ⇒ **值长 32–126**）会被**吞进键名** ✗ ⇒ `--key <键>` 报 **0 命中**、
 *     键名显示成 `"<键><尾字符>"` ✗（实测：值长 32 ⇒ 尾空格；126 ⇒ 尾 `~`；31/127 ⇒ 正常 ✓）
 *
 * 只读：不修改任何文件。应用运行中 leveldb 被锁（读会 `EBUSY`，**不是本工具坏了**）⇒ 先停应用，
 * 或对**真实 profile 做只读**扫描（绝不写）。
 * 用法（**从仓库根或 `modu/` 下都可**，路径会自动定位）：
 *   node modu/tests/tools/scan-markers.mjs [--dir <leveldb>] [--key <键>] [--profile-rel <相对 %LOCALAPPDATA%>]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}
const profileRel =
  typeof args['profile-rel'] === 'string'
    ? args['profile-rel']
    : path.join('com.modu.reader', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
/** 只扫某一个键（不传 ⇒ 只看默认目标键 `modu-recent`，但 `allKeysSummary` 仍列全部 ✓）*/
const onlyKey = typeof args.key === 'string' ? args.key : null;

/** `--dir` 先按调用者 cwd 解析；不存在再按【仓库根】（本工具往上三层）试一次 ⇒ 从哪跑都行 ✓ */
function resolveDir(raw) {
  if (existsSync(raw)) return raw;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const alt = path.resolve(repoRoot, raw);
  return existsSync(alt) ? alt : raw;
}

/** 编码标签（本项目取证结论）：`0x00` = Latin1/1 字节 · `0x01` = UTF-16LE —— 两者都不可打印 ✓ */
const ENCODING_LABELS = [0x00, 0x01];

/** LEB128 变长无符号数（Chromium/leveldb 的值长编码） */
function readVarint(buf, at) {
  let value = 0;
  let shift = 0;
  let size = 0;
  while (at + size < buf.length && size < 5) {
    const b = buf[at + size];
    value += (b & 0x7f) * 2 ** shift;
    size += 1;
    if ((b & 0x80) === 0) return { value, size };
    shift += 7;
  }
  return null;
}

/**
 * 值区域之后是否**恰好**落在"记录分界"（**单一实现，两处候选共用** ✓）。
 *
 * ⚠ 收紧史（2026-09-23，真实字节定性）：旧版写的是"其后 **64 字节内**出现 `\x00\x01`" ✗ ⇒ **太宽** ✗：
 *   真实 profile 上 `modu-recent` 被缩短成 `modu-recen` ✗（`ve=2542`，而真分界在 @3030，**差 488 字节**也放行 ✓）
 *   ⇒ 缩短的**唯一后果是改坏键名** ✗（两种解释的 `vs` 本来相同 ⇒ 值起点从未变 ✓）
 * ⇒ 现在只认两种"恰好"：**`end` 就是缓冲末尾** ✓ 或 **`end` 处正好是下一条记录的 `\x00\x01`** ✓。
 */
function landsOnRecordBoundary(buf, end) {
  if (end >= buf.length) return true;
  return buf[end] === 0x00 && buf[end + 1] === 0x01;
}

/**
 * 标记之后解析：先取 key（可打印 ASCII，最长 60），再解析值。
 *
 * ⚠ **布局 B 修正（只可能缩短键尾，绝不动布局 A 的正常结果）**：
 * 设游程尾 `runEnd`、候选 varint 大小 `size ∈ {1,2}` ⇒ 候选键尾 `e = runEnd - size` ⇒ 解出值长 `L`
 * ⇒ 三条件**同时**成立才把键尾缩到 `e`：
 *   ① varint 自洽（读出的 `size` 与假设一致）
 *   ② `e + size + L` 落在**记录分界**（或缓冲末尾）
 *   ③ 值首字节 ∈ `{0x00, 0x01}`（编码标签枚举 —— **格式常量，不是内容启发式** ✓）
 * ⇒ 缺一就**维持原行为**（布局 A ✓）。
 *
 * 为什么不用"可打印串之后的下一个字节仍可打印"当触发条件（曾被这样设计 ✗）：
 * 布局 B 触发时**值长已被吞进游程**，游程之后遇到的是**值的编码标签 `0x00/0x01`（不可打印）** ⇒
 * 那个条件**永远不成立**，等于没修 ✗ ⇒ 故改用上面的结构判据（内容无关 ✓）。
 */
function parseAfterMark(buf, at) {
  let runEnd = at + 2;
  while (runEnd < buf.length && runEnd - (at + 2) < 60) {
    const b = buf[runEnd];
    if (b < 0x20 || b > 0x7e) break;
    runEnd += 1;
  }
  let keyEnd = runEnd;
  let valueStart = runEnd;
  for (const size of [1, 2]) {
    const e = runEnd - size;
    if (e <= at + 2) continue;
    const v = readVarint(buf, e);
    if (v === null || v.size !== size) continue;
    const vs = e + size;
    const ve = vs + v.value;
    if (ve > buf.length) continue;
    if (!ENCODING_LABELS.includes(buf[vs])) continue;
    if (!landsOnRecordBoundary(buf, ve)) continue;
    keyEnd = e;
    valueStart = vs;
    break;
  }
  // ⚠ **对称补齐（2026-09-23 实测）**：值长**不可打印**（<0x20 或 >0x7e）时，游程**在键尾就停** ⇒
  //   长度字节会被当成"值的第一字节" ✗（实测值长 24 = 0x18 ⇒ 旧代码 region[0]=0x18 ⇒ raw 值取不出 ✗）。
  //   而**布局 B 一定有长度前缀** ⇒ 在 `runEnd` 处用**同一套判据**再试一次"键后有长度前缀"：
  //   键尾**不变** ✓，只把**值起点右移**到长度之后 ✓。布局 A 不受影响：它的"键后字节"是编码标签
  //   （值首字节，`0x00/0x01`）⇒ 标签若被当成长度 `L=0/1`，则 `buf[vs]` 要么越界、要么不是标签 ⇒ 必被拒 ✓
  if (valueStart === runEnd) {
    const v = readVarint(buf, runEnd);
    if (v !== null) {
      const vs = runEnd + v.size;
      const ve = vs + v.value;
      if (ve <= buf.length && vs < buf.length && ENCODING_LABELS.includes(buf[vs]) && landsOnRecordBoundary(buf, ve)) {
        valueStart = vs;
      }
    }
  }
  const key = buf.subarray(at + 2, keyEnd).toString('utf8');
  const region = buf.subarray(valueStart, Math.min(buf.length, valueStart + 12000));
  let value = null;
  let encoding = null;
  // ⚠ 两种**字节编码**都要试：纯 ASCII 值 Chromium 用 **1 字节（Latin1）** 存，
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
  // —— raw 回退：**只在 JSON 解析失败时**生效（绝不覆盖一次成功的 JSON 解析 ✗）
  //    ⚠ 必须按【标签字节】解码：0x00 ⇒ Latin1 · 0x01 ⇒ UTF-16LE（否则 UTF-16 原始串会成乱码 ✗）
  //    形如 `<标签><原始串><标签>`（如 `modu-workspace` = `\x01 + 路径 + \x01`）⇒ 去掉标签与尾部同值字节 ✓
  let rawValue = null;
  let rawEncoding = null;
  if (value === null && region.length > 1 && ENCODING_LABELS.includes(region[0])) {
    const used = region[0] === 0x01 ? 'utf16le' : 'latin1';
    for (const parity of used === 'utf16le' ? [0, 1] : [0]) {
      let text = region.subarray(1 + parity).toString(used);
      const cut = text.indexOf('\u0001');
      if (cut !== -1) text = text.slice(0, cut);
      text = text.replace(/\u0000/g, '');
      if (text.length > 0) {
        rawValue = text;
        rawEncoding = `${used}(parity=${parity})`;
        break;
      }
    }
  }
  return { key, value, encoding, rawValue, rawEncoding };
}

export { parseAfterMark, readVarint, landsOnRecordBoundary, ENCODING_LABELS };

/* 仅当作为脚本直接运行时才扫描（被 import 时无副作用 ✓ —— 供回归锚单测使用 ✓）*/
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dir =
    typeof args.dir === 'string'
      ? resolveDir(args.dir)
      : path.join(process.env.LOCALAPPDATA ?? os.homedir(), profileRel);
  if (!existsSync(dir)) {
    console.log(JSON.stringify({ error: `目录不存在: ${dir}` }, null, 1));
    process.exit(0);
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
        rawValue: parsed.rawValue,
        rawEncoding: parsed.rawEncoding,
        // ⚠ "看不见 ≠ 不存在"：三态必须可区分（json / raw / unparsed），不许把 unparsed 静默算成"没有" ✗
        parseState: parsed.value !== null ? 'json' : parsed.rawValue !== null ? 'raw' : 'unparsed',
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
      .map((m) => ({ file: m.file, offset: m.offset, mtime: m.mtime, valueCount: m.valueCount, parseState: m.parseState, isEmpty: m.value !== null && m.value.length === 0 })),
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
        /** 原始值命中（非 JSON，如 `modu-workspace` = `\x01 + 路径 + \x01`）*/
        rawValueHits: targetHits.filter((m) => m.parseState === 'raw'),
        /** ⚠ "看不见 ≠ 不存在"：命中但既非 JSON 也非 raw ⇒ 明确单列（而不是静默算作"没有"）✓ */
        unparsedHits: targetHits.filter((m) => m.parseState === 'unparsed'),
        timeline: targetHits.map((m) => ({ file: m.file, offset: m.offset, mtime: m.mtime, valueCount: m.valueCount, parseState: m.parseState, rawValue: m.rawValue })),
        lastTimelineEntry: targetHits[targetHits.length - 1] ?? null,
        allKeysSummary: summary,
        totalMarkers: markers.length,
      },
      null,
      1,
    ),
  );
}
