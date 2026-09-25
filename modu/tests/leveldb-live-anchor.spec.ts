/**
 * leveldb"live 值"选择锚（回归防护，2026-09-23）。
 *
 * 背景（真实翻车两连）：
 * 1. `extract-leveldb.mjs` 曾按"**取条数最多的一次命中**"当 live 值 —— 而 leveldb 保留被覆盖的历史版本
 *    ⇒ 挑中历史版本（10 条测试路径）⇒ 假警报"用户数据被污染"，白做数轮。
 * 2. 更根本的一条：它**只试 UTF-16LE** 解码 —— 而**纯 ASCII 值（如 `[]`）Chromium 用 1 字节 Latin1 存**
 *    ⇒ `[]` 对它**完全不可见**，于是报出"最新的 UTF-16 数组"（旧值）✗。
 *
 * ⚠ **代表性要求（Lead 指出，已验到字节级）**：旧夹具用 `Buffer.from(JSON.stringify(v),'utf16le')`
 * 把 `[]` 也写成 UTF-16LE（`5B 00 5D 00`）⇒ **只试 utf16le 的解析器照样能读出来** ⇒ 锚在合成世界一直绿。
 * 因此本锚**按真实编码规则构造**：`[]` 用 **Latin1/1 字节**、含中文的值用 **UTF-16LE**；
 * 并**双向**断言"**按时间序取最后一条、与编码无关**"。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const FIXTURE = path.join('.verify', 'leveldb-live-fixture');
const KEY = 'modu-recent';

/** 追加一条 `<marker><key><value>` 记录；`encoding` 决定值的**字节形态**（按真实编码规则） */
function appendRecord(file: string, value: unknown, encoding: 'latin1' | 'utf16le', mtimeOffsetMs: number): void {
  const marker = Buffer.from(`\u0000\u0001${KEY}`, 'utf8');
  const valueBuf = Buffer.from(JSON.stringify(value), encoding === 'latin1' ? 'latin1' : 'utf16le');
  writeFileSync(file, Buffer.concat([marker, valueBuf]), { flag: 'a' });
  const t = new Date(Date.now() + mtimeOffsetMs);
  utimesSync(file, t, t);
}

function runTool(dir: string) {
  const raw = execFileSync('node', ['tests/tools/extract-leveldb.mjs', '--dir', dir, '--key', KEY], { encoding: 'utf8' });
  return JSON.parse(raw) as {
    value: string[] | null;
    valueCount: number | null;
    historicalHits: number;
    rule: string;
    liveSource: { file: string; encoding: string } | null;
    decodeAttempts?: string[];
  };
}

describe('leveldb live 值选择锚（防"历史版本当现状" + 防"只试一种编码"）', () => {
  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('较新的是 Latin1 的 []、较旧的是 UTF-16LE 中文数组 ⇒ 必须报 []（编码不得影响选择）', () => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    appendRecord(path.join(FIXTURE, '000001.ldb'), ['D:\\旧目录\\计划.md', 'D:\\旧目录\\纪要.md'], 'utf16le', -120_000);
    appendRecord(path.join(FIXTURE, '000010.log'), [], 'latin1', 0);

    const parsed = runTool(FIXTURE);
    expect(parsed.valueCount, `live 值取错了：liveSource=${JSON.stringify(parsed.liveSource)}`).toBe(0);
    expect(parsed.value).toEqual([]);
    expect(parsed.liveSource?.encoding).toContain('latin1');
    // 输出必须自证"试过哪些解码"（看不见 ≠ 不存在）
    expect(parsed.decodeAttempts?.join(',')).toContain('latin1');
    expect(parsed.decodeAttempts?.join(',')).toContain('utf16le');
  });

  it('反例：较新的是 UTF-16LE 中文数组、较旧的是 Latin1 [] ⇒ 必须报**新的那条**（不许偏向 Latin1）', () => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    appendRecord(path.join(FIXTURE, '000001.ldb'), [], 'latin1', -120_000);
    appendRecord(path.join(FIXTURE, '000010.log'), ['D:\\新目录\\上午.md'], 'utf16le', 0);

    const parsed = runTool(FIXTURE);
    expect(parsed.valueCount).toBe(1);
    expect(parsed.value).toEqual(['D:\\新目录\\上午.md']);
    expect(parsed.liveSource?.encoding).toContain('utf16le');
  });

  it('规则自证：live 值 = 最新活动文件里的最后一次命中（与编码无关）', () => {
    const parsed = runTool(FIXTURE);
    expect(parsed.rule).toContain('最新活动文件');
  });
});
