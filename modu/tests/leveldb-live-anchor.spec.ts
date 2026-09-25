/**
 * leveldb"live 值"选择锚（回归防护，2026-09-23）。
 *
 * 背景（真实翻车）：`extract-leveldb.mjs` 曾用"**取条数最多的一次命中**"当 live 值 ——
 * 而 **leveldb 会保留被覆盖的历史版本**（compaction 前一直在）⇒ 它挑中了历史版本（10 条测试路径），
 * 据此判定"用户数据被污染、要清理"，**白做数轮**；**页面 live 值其实是 `[]`**。
 *
 * 本锚造一个**含两个版本的假 leveldb**（旧文件 N 条、新文件 `[]`，新文件 mtime 最新），
 * 断言工具报 **`[]`**（而不是 N 条），并要求输出里说明"live 值是怎么选出来的"。
 * 夹具写在 `.verify/`（gitignore），测试自建自删。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const FIXTURE = path.join('.verify', 'leveldb-live-fixture');
const KEY = 'modu-recent';

/** 写一个"像 leveldb 块"的文件：前导垃圾 + `\x00\x01<key>` 标记 + UTF-16LE 的 JSON 值 */
function writeVersion(file: string, entries: string[], mtimeOffsetMs: number): void {
  const marker = Buffer.from(`\u0000\u0001${KEY}`, 'utf8');
  const value = Buffer.from(JSON.stringify(entries), 'utf16le');
  writeFileSync(file, Buffer.concat([Buffer.from('X'.repeat(64), 'utf8'), marker, value]));
  const t = new Date(Date.now() + mtimeOffsetMs);
  utimesSync(file, t, t);
}

describe('leveldb live 值选择锚（防"把历史版本当现状"）', () => {
  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('旧文件 10 条 + 新文件 [] ⇒ 工具必须报 []（不是 10 条），并说明 live 值的来源', () => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    writeVersion(path.join(FIXTURE, '000001.ldb'), Array.from({ length: 10 }, (_, i) => `D:\\old\\file-${i}.md`), -60_000);
    writeVersion(path.join(FIXTURE, '000010.log'), [], 0);

    const raw = execFileSync('node', ['tests/tools/extract-leveldb.mjs', '--dir', FIXTURE, '--key', KEY], { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as {
      value: unknown;
      valueCount: number;
      historicalHits: number;
      rule: string;
      liveSource: { file: string } | null;
    };

    // ⚠ 这两条是本锚的要点：live 值必须是**新文件**里的那个（[]），历史版本只计数
    expect(parsed.valueCount, `live 值取错了：liveSource=${JSON.stringify(parsed.liveSource)}`).toBe(0);
    expect(parsed.value).toEqual([]);
    expect(parsed.historicalHits).toBeGreaterThan(0);
    // 输出里必须能看出"这个 live 值是怎么选出来的"
    expect(parsed.rule).toContain('最新活动文件');
    expect(parsed.liveSource?.file).toBe('000010.log');
  });

  it('反例：若新文件的 mtime 比旧文件更旧 ⇒ 按规则仍取 mtime 最新的那个（旧文件里条数多的反而"更新"时才取它）', () => {
    rmSync(FIXTURE, { recursive: true, force: true });
    mkdirSync(FIXTURE, { recursive: true });
    writeVersion(path.join(FIXTURE, '000001.ldb'), ['D:\\older\\only.md'], -120_000);
    writeVersion(path.join(FIXTURE, '000010.log'), ['D:\\newer\\a.md', 'D:\\newer\\b.md'], 0);

    const raw = execFileSync('node', ['tests/tools/extract-leveldb.mjs', '--dir', FIXTURE, '--key', KEY], { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as { value: string[]; valueCount: number; liveSource: { file: string } | null };
    expect(parsed.valueCount).toBe(2);
    expect(parsed.value).toEqual(['D:\\newer\\a.md', 'D:\\newer\\b.md']);
    expect(parsed.liveSource?.file).toBe('000010.log');
  });
});
