/**
 * `scan-markers.mjs` 回归锚（D-11 附带修复，2026-09-23）
 *
 * 背景（先红后绿，原始读数见批次报告）：
 *   布局 B（`.log` WriteBatch）的记录形如 `… + 键 + varint(值长) + 值` ⇒ 值长低字节若**可打印**
 *   （`0x20–0x7e` ⇒ **值长 32–126**）会被旧的「按可打印 ASCII 找键尾」**吞进键名** ✗
 *   ⇒ `--key <键>` 报 **0 命中**、键名显示成 `"<键><尾字符>"` ✗（实测：32 ⇒ 尾空格、126 ⇒ 尾 `~`；31/127 ⇒ 正常 ✓）
 *
 * 本锚**两条都测**（Lead 明确要求 ✓）：
 *   1. **函数级**：直接测 `parseAfterMark`（值长 31/32/126/127 × 编码 0x00/0x01 ＋ **布局 A 对抗样例** ＋ raw 回退按标签解码）
 *   2. ⭐ **CLI 冒烟**：以**子进程跑工具本体** ⇒ 断言 `exit 0` 且**命中 1**
 *      —— 这条专防"顶层常量/参数解析被改坏"那类错 ✗（本会话真实踩过：删掉顶层 `const onlyKey` ⇒
 *      函数级测试照样全绿、但**工具作为 CLI 一跑就崩** ✗）⇒ 函数级锚抓不到它，必须有 CLI 冒烟 ✓
 *
 * ⚠ 夹具必须与真实字节布局一致（`AGENTS.md`：**夹具不真 ⇒ 锚会绿现实会错** ✗）：
 *   值首字节是**编码标签** `0x00` = Latin1 / `0x01` = UTF-16（两者都不可打印 ✓）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface Parsed {
  key: string;
  value: string[] | null;
  encoding: string | null;
  rawValue: string | null;
  rawEncoding: string | null;
}
interface ScanMarkers {
  parseAfterMark(buf: Buffer, at: number): Parsed;
}

/** 动态 import 工具本体（`.mjs` 无类型 ⇒ 经 `unknown` 收窄，不用 `any` ✓）*/
async function loadTool(): Promise<ScanMarkers> {
  return (await import('./tools/scan-markers.mjs')) as unknown as ScanMarkers;
}

const ORIGIN = Buffer.from('_http://localhost:1420', 'latin1');
const SEP = Buffer.from([0x00, 0x01]);
const TOOL = path.resolve(__dirname, 'tools', 'scan-markers.mjs');

function encodePayload(text: string, label: number): Buffer {
  return Buffer.from(text, label === 0x01 ? 'utf16le' : 'latin1');
}

/**
 * 布局 B：`\x00\x01 + 键 + varint(值长) + [标签 + 值]`（值长用单字节 varint，落在 32–126 触发区间）
 * ⚠ 夹具**以标记开头** ⇒ `parseAfterMark(buf, 0)` 的 `at` 语义（"标记偏移"）直接成立 ✓
 *   （旧版把 `ORIGIN` 放最前、却仍传 `at=0` ✗ ⇒ 键名读成 `ttp://localhost:1420` ⇒ 4 条锚假红 ✗）
 */
function layoutB(key: string, valueLen: number, label: number, valueText = '[]'): Buffer {
  const payload = Buffer.concat([Buffer.from([label]), encodePayload(valueText, label)]);
  const padded = Buffer.concat([payload, Buffer.alloc(Math.max(0, valueLen - payload.length), 0x20)]);
  return Buffer.concat([SEP, Buffer.from(key, 'latin1'), Buffer.from([padded.length]), padded]);
}

/** 布局 A：`\x00\x01 + 键 + [标签 + 值]`（**键后直接是值**，无长度前缀 ✓）*/
function layoutA(key: string, label: number, valueText = '[]'): Buffer {
  return Buffer.concat([SEP, Buffer.from(key, 'latin1'), Buffer.from([label]), encodePayload(valueText, label)]);
}

describe('scan-markers 锚 · 函数级：布局 B 的值长吞并必须被修正', () => {
  it('值长 31/32/126/127 × 编码 0x00/0x01 ⇒ 键名一字不多，且 JSON 值可取', async () => {
    const { parseAfterMark } = await loadTool();
    for (const label of [0x00, 0x01]) {
      for (const valueLen of [31, 32, 126, 127]) {
        const key = `modu-t${label}-n${valueLen}`;
        const buf = layoutB(key, valueLen, label, '[]');
        const parsed = parseAfterMark(buf, 0);
        expect(parsed.key, `值长 ${valueLen} / 标签 0x0${label} 的键名`).toBe(key);
        expect(parsed.value, `值长 ${valueLen} 的 JSON 值应可取`).toEqual([]);
      }
    }
  });

  it('布局 A 对抗样例：键尾本身是可打印「长度值」且其后紧跟 0x00/0x01 ⇒ 键名一字不少', async () => {
    const { parseAfterMark } = await loadTool();
    for (const tail of ['t', '~', ' ']) {
      for (const label of [0x00, 0x01]) {
        const key = `modu-adv-${tail === ' ' ? 'sp' : tail}`;
        const withTail = key + tail; // 末字节 = 可打印长度值（0x74 / 0x7e / 0x20）
        const parsed = parseAfterMark(layoutA(withTail, label, '[]'), 0);
        expect(parsed.key, `键尾 ${JSON.stringify(tail)} / 标签 0x0${label} 不得被缩短`).toBe(withTail);
        expect(parsed.value).toEqual([]);
      }
    }
  });

  it('raw 回退：JSON 解析失败时按【标签字节】解码（0x00⇒Latin1 · 0x01⇒UTF-16）⇒ 原文可读', async () => {
    const { parseAfterMark } = await loadTool();
    // ⚠ **按标签各用"能装得下"的载荷**：Latin1 装不下 CJK ⇒ 对它断言中文路径必然乱码 ✗（我第一次就这么写错了 ✓）
    //   ⇒ UTF-16（0x01）用中文路径验"可读"，Latin1（0x00）用 ASCII 路径验"可读" ✓
    for (const [label, rawText] of [
      [0x01, 'D:\\工作区\\笔记\\a.md'],
      [0x00, 'D:\\notes\\a.md'],
    ] as [number, string][]) {
      const payload = Buffer.concat([Buffer.from([label]), encodePayload(rawText, label), Buffer.from([label])]);
      // ⚠ 夹具以**标记**开头（与 layoutB 一致 ✓）⇒ `parseAfterMark(buf, 0)` 的 `at` 语义成立 ✓
      const buf = Buffer.concat([SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([payload.length]), payload]);
      const parsed = parseAfterMark(buf, 0);
      expect(parsed.key).toBe('modu-workspace');
      expect(parsed.value, '非 JSON ⇒ value 应为 null（不假装解析成功）').toBeNull();
      expect(parsed.rawValue, `标签 0x0${label} 的原始串必须可读（不得呈乱码）`).toBe(rawText);
    }
  });

  it('反向：能解析成 JSON 时，raw 回退不得覆盖它', async () => {
    const { parseAfterMark } = await loadTool();
    const parsed = parseAfterMark(layoutB('modu-recent', 32, 0x01, '["D:\\\\x.md"]'), 0);
    expect(parsed.key).toBe('modu-recent');
    expect(parsed.value).toEqual(['D:\\x.md']);
    expect(parsed.rawValue, 'JSON 成功时不得再给 raw（否则等于覆盖）').toBeNull();
  });
  it('⭐ 键名不得退化：真实键名样例（layout A 与 B）都必须一字不少', async () => {
    const { parseAfterMark } = await loadTool();
    // 这条锚**正是为 2026-09-23 那次真实字节假阳性而加** ✗：
    //   真实 profile 上 `modu-recent` 被缩短成 `modu-recen`（`modu-theme`→`modu-them`、`modu-width`→`modu-widt`）✗
    //   根因是"值末落在其后 64 字节内即算分界"太宽 ✗ ⇒ 收紧为"末尾或恰好是下一条标记" ✓
    //   ⇒ 若判据再被放松，这条锚会**当场红** ✓（退化键名 = 键名少 1–2 字符 ✓）
    for (const key of ['modu-recent', 'modu-theme', 'modu-width']) {
      for (const build of [() => layoutA(key, 0x01, '[]'), () => layoutB(key, 40, 0x01, '[]')]) {
        const parsed = parseAfterMark(build(), 0);
        expect(parsed.key, `键名不得退化（真实样例 ${key}）`).toBe(key);
      }
    }
  });

  it('通用不变式：raw 值必须与声明内容逐字相同（值区偏移错 1 字节就会红）', async () => {
    const { parseAfterMark } = await loadTool();
    // 用**已知内容**的原始值当不变式：只要值区起点错 1 字节，rawValue 就不再逐字相同 ✓
    // （比"断言键名"更强：它锁的是**值区边界** ✓ —— 2026-09-23 那个"值长不可打印 ⇒ 长度字节被当成值首字节"就属于此类 ✗）
    // ⚠ 两条教训（都发生在这条锚里）：
    //   ① 断言必须按**实际构造的值**比对（我第一次按"不含填充"比 ⇒ 假红 ✗）
    //   ② **绝不能在 UTF-16 流里塞单字节填充** ✗（`0x20` 单字节会让 UTF-16 尾巴错位 ⇒ 我第二次又假红 ✗）
    //   ⇒ 现在用**两个不同长度的真实样例**替代"填充"：既覆盖不同长度，又保证字节流自洽 ✓
    const samples: [number, string][] = [
      [0x01, 'D:\\工作区\\笔记\\a.md'],
      [0x01, 'D:\\工作区\\一个更长一些的笔记文件名.md'],
      [0x00, 'D:\\notes\\b.md'],
      [0x00, 'D:\\notes\\a-longer-name.md'],
    ];
    for (const [label, rawText] of samples) {
      const payload = Buffer.concat([Buffer.from([label]), encodePayload(rawText, label), Buffer.from([label])]);
      const buf = Buffer.concat([SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([payload.length]), payload]);
      const parsed = parseAfterMark(buf, 0);
      expect(parsed.key).toBe('modu-workspace');
      // 偏移一旦错 1 字节，这里就会少/多一个字符 ⇒ 该不变式仍然有效 ✓
      expect(parsed.rawValue, `值区必须逐字取到（标签 0x0${label}，长 ${rawText.length}）`).toBe(rawText);
    }
  });

  it('空值对抗：值仅一个标签字节（payload 0）⇒ 键名仍正确、且不得被误当成长度前缀', async () => {
    const { parseAfterMark } = await loadTool();
    // 这是新判据唯一的边缘误报面：`runEnd` 处读到自洽长度 + 恰好到末尾 ⇒ 可能把标签当长度 ✗
    for (const label of [0x00, 0x01]) {
      const value = Buffer.from([label]); // 值 = 仅标签（空内容）
      const buf = Buffer.concat([SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([value.length]), value]);
      const parsed = parseAfterMark(buf, 0);
      expect(parsed.key, '空值记录的键名必须正确').toBe('modu-workspace');
      expect(parsed.value, '空值不是 JSON ⇒ value 为 null').toBeNull();
      // 空内容 ⇒ rawValue 也应为 null（工具**不得**凭空造出一个字符串 ✓）
      expect(parsed.rawValue, '空值不得被"解读"出内容').toBeNull();
    }
  });
});

describe('scan-markers 锚 · CLI 冒烟（防"入口被改坏但函数级全绿"）', () => {
  it('子进程跑工具本体：exit 0 且四个触发点各命中 1（含 parseState 三态可区分）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'modu-scanmarkers-'));
    try {
      for (const label of [0x00, 0x01]) {
        for (const valueLen of [31, 32, 126, 127]) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path.join(dir, `rec-${label}-${valueLen}.log`), layoutB(`modu-t${label}-n${valueLen}`, valueLen, label, '[]'));
        }
      }
      // raw 值那一条（非 JSON，标签为 UTF-16）⇒ CLI 应报 parseState=raw 且 rawValue 可读
      const rawText = 'D:\\工作区\\b.md';
      const rawPayload = Buffer.concat([Buffer.from([0x01]), encodePayload(rawText, 0x01), Buffer.from([0x01])]);
      writeFileSync(
        path.join(dir, 'rec-raw.log'),
        Buffer.concat([ORIGIN, SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([rawPayload.length]), rawPayload]),
      );

      const run = (key: string) =>
        spawnSync(process.execPath, [TOOL, '--dir', dir, '--key', key], { encoding: 'utf8' });
      for (const label of [0x00, 0x01]) {
        for (const valueLen of [31, 32, 126, 127]) {
          const key = `modu-t${label}-n${valueLen}`;
          const r = run(key);
          expect(r.status, `CLI 必须 exit 0（stderr: ${r.stderr}）`).toBe(0);
          const json = JSON.parse(r.stdout) as { timeline: { parseState: string }[] };
          expect(json.timeline.length, `--key ${key} 应命中 1（先红时触发点为 0）`).toBe(1);
          expect(json.timeline[0].parseState).toBe('json');
        }
      }
      const rawRun = run('modu-workspace');
      expect(rawRun.status).toBe(0);
      const rawJson = JSON.parse(rawRun.stdout) as { timeline: { parseState: string; rawValue: string | null }[] };
      expect(rawJson.timeline.length, '非 JSON 的键也必须"可见"（看不见 ≠ 不存在）').toBe(1);
      expect(rawJson.timeline[0].parseState).toBe('raw');
      expect(rawJson.timeline[0].rawValue).toBe(rawText);

      // 不存在的键 ⇒ 明确"没有"（timeline 空），而不是"未能解析"（unparsedHits 非空）
      const missing = JSON.parse(run('modu-不存在').stdout) as { timeline: unknown[]; unparsedHits: unknown[] };
      expect(missing.timeline.length, '没有该键 ⇒ 空时间线').toBe(0);
      expect(missing.unparsedHits.length, '没有该键 ⇒ 不得混进"未能解析"').toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
