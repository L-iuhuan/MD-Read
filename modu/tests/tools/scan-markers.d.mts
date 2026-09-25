/**
 * `scan-markers.mjs` 的最小型别声明（**供 `tests/scan-markers-anchor.spec.ts` 动态 import** ✓）。
 *
 * 为什么需要它（2026-09-23 实测）：spec 里写 `await import('./tools/scan-markers.mjs')` ✗ ⇒
 * `tsc --strict` 报 **`TS7016: Could not find a declaration file for module … implicitly has an 'any' type`** ✗
 * —— **"加一个 `as unknown as X` 断言"并不能消掉这条** ✓（断言只改类型流，不提供模块声明 ✗）
 * ⇒ 正确做法就是补这份声明 ✓（放在 `.mjs` 旁边，TS 按 `模块名.d.mts` 解析 ✓）。
 *
 * 注意：这里只声明 spec 真正用到的四样 ✓（工具本体是 `.mjs`、无独立类型源 ✓）。
 */

/**
 * `parseAfterMark` 的返回：`value` 与 raw 字段**互斥**（JSON 成功则 raw 为 null ✓，反之亦然 ✓）。
 *
 * ⚠ **可信范围按【记录布局】分（不是按标签分 ✗）**：
 *   · `layout: 'batch'`（有 `.log` 框架、边界由结构给出 ✓）⇒ 值区可信 ✓
 *   · `layout: 'marker'`（无框架 / `.ldb` 等，走旧的"猜分界" ✗）⇒ **值区本身可能错位** ✗
 *     ⇒ 该路径的 raw 值**仅供参考、不得单独采信** ✗（2026-09-23 实测：真机 95 条里 `marker:78 · batch:17`）
 */
export interface ParsedMarker {
  key: string;
  value: string[] | null;
  encoding: string | null;
  /** 向后兼容：沿用旧的按标签推断 ✗ ⇒ **可信度取决于布局**（见上）⇒ 新代码请用下面两个字段 ✓ */
  rawValueLegacy: string | null;
  /** 按 Latin1/1 字节解出的原始值（与 `rawValueUtf16` **同时给** ✓ —— 兜住未覆盖形态 ✓）*/
  rawValueLatin1: string | null;
  /** 按 UTF-16LE 解出的原始值 ✓ */
  rawValueUtf16: string | null;
  rawEncoding: string | null;
  /** 产生该命中的路径：`batch` = 结构解析 ✓ · `marker` = 旧的标记猜测 ✗ */
  layout?: 'batch' | 'marker';
}

/** 从标记偏移处解析键与值（`at` 是**标记 `\x00\x01` 的偏移** ✓，不是键的偏移 ✗）*/
export function parseAfterMark(buf: Buffer, at: number, bounds?: { name: string; valueStart: number; valueEnd: number }): ParsedMarker;

/** LEB128 变长无符号数（Chromium/leveldb 的值长编码）*/
export function readVarint(buf: Buffer, at: number): { value: number; size: number } | null;

/** 值区域之后是否**恰好**落在记录分界（缓冲末尾，或 `end` 处正好是下一条记录的 `\x00\x01`）*/
export function landsOnRecordBoundary(buf: Buffer, end: number): boolean;

/**
 * 编码标签（**2026-09-23 只在 `layout:'batch'` 记录上重验过** ✓ —— 同类 18/18 ✓）：
 * **`0x00` = UTF-16LE · `0x01` = Latin1/1 字节** ✓
 * ⚠ 早先笔记里写的「`0x00`=Latin1 / `0x01`=UTF-16」**是反的** ✗（当时误判为"标签不可靠"，实为
 *   **拿不可靠的 marker 路径记录去比** ⇒ 见 `AGENTS.md` 的"同类相比"那条 ✓）
 */
export const ENCODING_LABELS: number[];
