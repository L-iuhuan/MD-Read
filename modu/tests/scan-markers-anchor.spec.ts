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
 *   值首字节是**编码标签** `0x00` = **UTF-16LE** / `0x01` = **Latin1/1 字节**（两者都不可打印 ✓）
 *   （2026-09-23 **只在 `layout:'batch'` 记录上重验**：同类 18/18 ✓ —— 早先此处与笔记写反了 ✗，见 `scan-markers.d.mts` 注释）
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedMarker } from './tools/scan-markers.mjs';

/**
 * ⭐ **只用【唯一一份】类型声明** ✓ —— 这里此前自己又抄了一份 `interface Parsed`（少两个新字段 ✗）
 * ⇒ `tsc` 直接报 `TS2339` / `TS7053` ✗（2026-09-23 实测：门禁 `check:full` EXIT=2 拦下提交 ✓，零部分提交 ✓）
 * ⇒ 改为**别名到 `.d.mts` 的 `ParsedMarker`** ✓：类型只有一处定义 ⇒ 这类"副本过期"不可能再发生 ✓
 */
type Parsed = ParsedMarker;
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
  // ⭐ **新映射**（2026-09-23 只在 layout:'batch' 记录上重验，同类 18/18 ✓）：**0x00 ⇒ UTF-16LE · 0x01 ⇒ Latin1**
  //   （旧版写成 `label === 0x01 ? 'utf16le' : 'latin1'` ✗ = 旧映射 ⇒ **构造侧**仍按旧映射造字节 ✗
  //    ⇒ 所有"按形态逐字相同"的断言必然对不上 ✗ —— "改映射要清点【全部承载面】"的第 2 例 ✓：
  //      解析侧 ✓ 构造侧（就是这里）✓ 文档/注释 ✓ 断言 ✓）
  return Buffer.from(text, label === 0x00 ? 'utf16le' : 'latin1');
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

  it('raw 回退：两种解码都在，且【按记录形态】至少一条与原文逐字相同', async () => {
    const { parseAfterMark } = await loadTool();
    // ⭐ 新映射（2026-09-23 只在 layout:'batch' 记录上重验，同类 18/18 ✓）：**0x00 ⇒ UTF-16LE · 0x01 ⇒ Latin1**
    //   （早先笔记写的 "0x00=Latin1 / 0x01=UTF-16" **是反的** ✗）
    // ⚠ **"可读"必须按记录的实际形态指定解码** —— 两种解码对**同一条记录**是**互斥**的 ✗：
    //   tag=0x01 + ASCII ⇒ UTF-16 必乱 ✓；tag=0x00 + UTF-16 ⇒ Latin1 必乱 ✓
    //   ⇒ 要求"两种解码同时可读"是**逻辑上不可能**的 ✗ ⇒ 断言 =【两条都在】＋【按形态那条逐字相同】＋【另一条不同】
    const cases: { label: number; text: string; field: 'rawValueUtf16' | 'rawValueLatin1'; why: string }[] = [
      { label: 0x00, text: 'D:\\工作区\\笔记\\a.md', field: 'rawValueUtf16', why: 'tag=0x00 ⇒ UTF-16LE ✓' },
      { label: 0x01, text: 'D:\\notes\\a.md', field: 'rawValueLatin1', why: 'tag=0x01 ⇒ Latin1（内容只能是 ASCII ✓）' },
    ];
    for (const c of cases) {
      const payload = Buffer.concat([Buffer.from([c.label]), encodePayload(c.text, c.label), Buffer.from([c.label])]);
      const buf = Buffer.concat([SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([payload.length]), payload]);
      const parsed = parseAfterMark(buf, 0);
      expect(parsed.key).toBe('modu-workspace');
      expect(parsed.value, '非 JSON ⇒ value 应为 null（不假装解析成功）').toBeNull();
      expect(parsed.rawValueLatin1, 'Latin1 解必须在').not.toBeNull();
      expect(parsed.rawValueUtf16, 'UTF-16LE 解必须在').not.toBeNull();
      expect(parsed[c.field], c.why).toBe(c.text);
      const other = c.field === 'rawValueUtf16' ? parsed.rawValueLatin1 : parsed.rawValueUtf16;
      expect(other, '另一条解码应因形态不符而不同（互斥性 ✓ —— 不是"碰巧都能读"✗）').not.toBe(c.text);
    }
  });

  it('反向：能解析成 JSON 时，raw 回退不得覆盖它', async () => {
    const { parseAfterMark } = await loadTool();
    const parsed = parseAfterMark(layoutB('modu-recent', 32, 0x01, '["D:\\\\x.md"]'), 0);
    expect(parsed.key).toBe('modu-recent');
    expect(parsed.value).toEqual(['D:\\x.md']);
    expect(parsed.rawValueLegacy, 'JSON 成功时不得再给 raw（否则等于覆盖）').toBeNull();
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
    // 用**已知内容**的原始值当不变式：只要值区起点错 1 字节，rawValueLegacy 就不再逐字相同 ✓
    // （比"断言键名"更强：它锁的是**值区边界** ✓ —— 2026-09-23 那个"值长不可打印 ⇒ 长度字节被当成值首字节"就属于此类 ✗）
    // ⚠ 两条教训（都发生在这条锚里）：
    //   ① 断言必须按**实际构造的值**比对（我第一次按"不含填充"比 ⇒ 假红 ✗）
    //   ② **绝不能在 UTF-16 流里塞单字节填充** ✗（`0x20` 单字节会让 UTF-16 尾巴错位 ⇒ 我第二次又假红 ✗）
    //   ⇒ 现在用**两个不同长度的真实样例**替代"填充"：既覆盖不同长度，又保证字节流自洽 ✓
    // ⭐ **按新映射重建样本**（0x00 ⇒ UTF-16LE ✓ / 0x01 ⇒ Latin1 ✓）：
    //   · CJK 内容**只能**走 UTF-16（Latin1 装不下 ⇒ 必然乱码 ✗）⇒ 配 tag=0x00 ✓
    //   · ASCII 内容配 tag=0x01（Latin1 ✓）✓
    //   ⚠ 这是"改映射要清点【全部承载面】"里最容易漏的一处：**构造侧的样本数组** ✗
    const samples: { label: number; text: string; field: 'rawValueUtf16' | 'rawValueLatin1' }[] = [
      { label: 0x00, text: 'D:\\工作区\\笔记\\a.md', field: 'rawValueUtf16' },
      { label: 0x00, text: 'D:\\工作区\\一个更长一些的笔记文件名.md', field: 'rawValueUtf16' },
      { label: 0x01, text: 'D:\\notes\\b.md', field: 'rawValueLatin1' },
      { label: 0x01, text: 'D:\\notes\\a-longer-name.md', field: 'rawValueLatin1' },
    ];
    for (const sample of samples) {
      const payload = Buffer.concat([
        Buffer.from([sample.label]),
        encodePayload(sample.text, sample.label),
        Buffer.from([sample.label]),
      ]);
      const buf = Buffer.concat([SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([payload.length]), payload]);
      const parsed = parseAfterMark(buf, 0);
      expect(parsed.key).toBe('modu-workspace');
      // 偏移一旦错 1 字节，这里就会少/多一个字符 ⇒ 该不变式仍然有效 ✓（强度不降 ✓：仍锁"逐字相同"）
      expect(parsed[sample.field], `值区必须逐字取到（tag=0x0${sample.label}）`).toBe(sample.text);
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
      // 空内容 ⇒ rawValueLegacy 也应为 null（工具**不得**凭空造出一个字符串 ✓）
      expect(parsed.rawValueLegacy, '空值不得被"解读"出内容').toBeNull();
    }
  });
  // ⭐ 原「真实形态（可打印值长 + 值后紧跟下一条记录）」函数级锚**已删除**（2026-09-23）——
  //   原因：结构路径在**主循环**里 ⇒ **函数级单测永远够不到它** ✗ ⇒ 留着只会长期假红 ✗
  //   覆盖已**搬到**下方 `CLI 冒烟` 的 framed 用例（**更强** ✓）：
  //     · 真 `.log` 框架（`[crc][len][type]` + `seq(8)+count(4)+记录`，count 与条数一致 ＋ 恰好用尽数据区 ✓）
  //     · 两条记录 + **第二条用不同的键** ⇒ 第一条值末落在**缓冲中间** ✓（= 原锚的失败条件 ✓）
  //     · 断言三件事：命中 1 ✓ ＋ `layout === 'batch'` ✓ ＋ **raw 值按形态逐字相同** ✓
  //   删除前已逐条核对"原锚的失败条件在新锚里可复现" ✓（值长 32 = 0x20 可打印 ✓ ＋ 后随不同键记录 ✓）
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
      // raw 值那一条：**按新映射**（0x01 ⇒ Latin1 ⇒ 内容只能 ASCII ✓）
      const rawText = 'D:\\notes\\b.md';
      const rawPayload = Buffer.concat([Buffer.from([0x01]), encodePayload(rawText, 0x01), Buffer.from([0x01])]);
      writeFileSync(
        path.join(dir, 'rec-raw.log'),
        Buffer.concat([ORIGIN, SEP, Buffer.from('modu-workspace', 'latin1'), Buffer.from([rawPayload.length]), rawPayload]),
      );

      // ⭐ 真 `.log` 框架 + WriteBatch —— 一次覆盖三件事 ✓：
      //   ① 真框架形态（否则结构路径不启用 ✗）② 值后【紧跟另一条记录】（旧"猜分界"判据的**误杀面** ✓，
      //      故第二条**必须用不同的键** ✗⇒ 同键会让边界歧义消失 ✓）③ **取到对的值**且走的是结构路径 ✓
      //   ⚠ 结构路径在**主循环**里 ⇒ **函数级单测够不到** ✗ ⇒ 必须走这条 CLI 冒烟 ✓
      const framedKey = 'modu-framed-a';
      const framedText = 'D:\\framed\\a.md';
      const framedKeyB = 'modu-framed-b';
      const framedTextB = 'D:\\framed\\b-longer-name.md';
      const varint = (n: number): Buffer => (n < 0x80 ? Buffer.from([n]) : Buffer.from([(n & 0x7f) | 0x80, n >> 7]));
      const le16 = (n: number): Buffer => {
        const b = Buffer.alloc(2);
        b.writeUInt16LE(n, 0);
        return b;
      };
      const le32 = (n: number): Buffer => {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(n, 0);
        return b;
      };
      const mkRecord = (key: string, label: number, text: string): Buffer => {
        const fullKey = Buffer.from(`${ORIGIN.toString('latin1')}\u0000\u0001${key}`, 'latin1');
        const payload = Buffer.concat([Buffer.from([label]), encodePayload(text, label), Buffer.from([label])]);
        return Buffer.concat([Buffer.from([0x01]), varint(fullKey.length), fullKey, varint(payload.length), payload]);
      };
      const framedBody = Buffer.concat([mkRecord(framedKey, 0x00, framedText), mkRecord(framedKeyB, 0x01, framedTextB)]);
      const framedData = Buffer.concat([Buffer.alloc(8), le32(2), framedBody]); // seq(8) + count(4)=2 ✓（两条自证 ✓）
      const framedLog = Buffer.concat([le32(0), le16(framedData.length), Buffer.from([0x01]), framedData]); // crc+len+type ✓
      writeFileSync(path.join(dir, 'framed.log'), framedLog);

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
      const rawJson = JSON.parse(rawRun.stdout) as { timeline: { parseState: string; rawValueLatin1: string | null }[] };
      expect(rawJson.timeline.length, '非 JSON 的键也必须"可见"（看不见 ≠ 不存在）').toBe(1);
      expect(rawJson.timeline[0].parseState).toBe('raw');
      // ⭐ 按形态取：tag=0x01 + ASCII ⇒ **Latin1 那条**逐字相同 ✓（UTF-16 那条此形态下必乱 ✓，不在此断言）
      expect(rawJson.timeline[0].rawValueLatin1).toBe(rawText);

      // ⭐ 真框架那条（走结构路径 ✓ ＋ 值后紧跟另一条记录 ✓ ＋ 取到对的值 ✓）
      const framedRun = run(framedKey);
      expect(framedRun.status, `framed CLI 必须 exit 0（stderr: ${framedRun.stderr}）`).toBe(0);
      const framedJson = JSON.parse(framedRun.stdout) as {
        timeline: { layout?: string; parseState: string; rawValueUtf16: string | null }[];
      };
      expect(framedJson.timeline.length, 'framed 记录应命中 1（旧判据会误杀 ⇒ 0 ✗）').toBe(1);
      expect(framedJson.timeline[0].layout, '必须走【结构】路径（= 夹具真被当成 .log 解析 ✓）').toBe('batch');
      expect(framedJson.timeline[0].rawValueUtf16, '走了结构路径还必须取到【对的值】✓').toBe(framedText);

      // 不存在的键 ⇒ 明确"没有"（timeline 空），而不是"未能解析"（unparsedHits 非空）
      const missing = JSON.parse(run('modu-不存在').stdout) as { timeline: unknown[]; unparsedHits: unknown[] };
      expect(missing.timeline.length, '没有该键 ⇒ 空时间线').toBe(0);
      expect(missing.unparsedHits.length, '没有该键 ⇒ 不得混进"未能解析"').toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
