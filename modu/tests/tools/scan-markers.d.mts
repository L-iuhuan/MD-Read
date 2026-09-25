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

/** `parseAfterMark` 的返回：`value` 与 `rawValue` **互斥**（JSON 成功则 raw 为 null ✓，反之亦然 ✓）*/
export interface ParsedMarker {
  key: string;
  value: string[] | null;
  encoding: string | null;
  rawValue: string | null;
  rawEncoding: string | null;
}

/** 从标记偏移处解析键与值（`at` 是**标记 `\x00\x01` 的偏移** ✓，不是键的偏移 ✗）*/
export function parseAfterMark(buf: Buffer, at: number): ParsedMarker;

/** LEB128 变长无符号数（Chromium/leveldb 的值长编码）*/
export function readVarint(buf: Buffer, at: number): { value: number; size: number } | null;

/** 值区域之后是否**恰好**落在记录分界（缓冲末尾，或 `end` 处正好是下一条记录的 `\x00\x01`）*/
export function landsOnRecordBoundary(buf: Buffer, end: number): boolean;

/** 编码标签（本项目取证结论）：`0x00` = Latin1/1 字节 · `0x01` = UTF-16LE */
export const ENCODING_LABELS: number[];
