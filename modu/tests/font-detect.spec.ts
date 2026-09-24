/**
 * 字体命中探测（D-02）契约——**这是本步最关键那一项的判据，不许弱化**。
 *
 * 用一张「假的字宽表」替掉 canvas：宽度只由「族名 + 字重」决定，于是能精确验证
 *   ① 拉丁串 + 两个字重各测一次；
 *   ② 假族名基线的存在（否则会假阳性）；
 *   ③ 400 命中 / 700 不命中 的字体被判为**不可用**（`Noto Sans SC` 就是这一类）；
 *   ④ 「实际生效」逐候选取第一个真命中的族；
 *   ⑤ 全不命中 → 「系统回退」。
 */
import { describe, expect, it } from "vitest";
import {
  BODY_WEIGHTS,
  LATIN,
  describeResolved,
  firstResolvedFamily,
  hitsAtWeight,
  isFamilyAvailable,
  makeMeasurer,
  markAvailability,
  resolveFamilies,
  splitFamilies,
  type MeasureText,
} from "../src/ui/font-detect";
import { firstFamilyOf } from "../src/ui/font-catalog";
import type { FontPickOption } from "../src/ui/font-catalog";

/** 真实字体表（值来自本机实测的字宽比，只用于区分「不同族宽度不同」这件事） */
const WIDTHS: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  "Known Sans": { 400: 575.792, 700: 575.792 },
  "Known Sed": { 400: 610.598, 700: 637.429 }, // 400/700 都命中，但宽度不同
  "Weight400Broken": { 700: 630.523 }, // 400 缺席 → 静默回退（Noto Sans SC 那一类）
  "Segoe UI": { 400: 546.25, 700: 588.531 },
};

/** 缺某个字重就返回「假族名」的宽度 = 基线，用来模拟 Chromium 的静默回退 */
const BOGUS_400 = 570.098;
const BOGUS_700 = 603.125;

/** 按 `<weight> 16px "<family>"` 拆解 font 简写并查表 */
const measure: MeasureText = (fontSpec) => {
  const parsed = /^(\d+)\s+16px\s+"(.+)"$/.exec(fontSpec);
  if (parsed === null) throw new Error(`探测字串格式不符：${fontSpec}`);
  const weight = Number.parseInt(parsed[1], 10);
  const family = parsed[2];
  const byWeight = WIDTHS[family];
  const width = byWeight?.[weight];
  if (width !== undefined) return width;
  return weight === 700 ? BOGUS_700 : BOGUS_400;
};

describe("探测判据：拉丁串 + 双字重 + 双假名基线", () => {
  it("探测串是纯拉丁（汉字在所有中文字体里都是 1em，量不出差别）", () => {
    expect(LATIN).toMatch(/^[A-Za-z0-9]+$/);
    expect(LATIN.length).toBeGreaterThan(32);
    expect(BODY_WEIGHTS).toEqual([400, 700]);
  });

  it("命中 = 与两个假族名基线都不同（单基线会假阳性）", () => {
    expect(hitsAtWeight(measure, "Known Sans", 400)).toBe(true);
    expect(hitsAtWeight(measure, "Weight400Broken", 400)).toBe(false); // 400 静默回退
    expect(hitsAtWeight(measure, "Weight400Broken", 700)).toBe(true); // 700 才命中
  });

  it("可用 = 正文两个字重**都**命中（400 失败即正文会静默回退）", () => {
    expect(isFamilyAvailable(measure, "Known Sans")).toBe(true);
    expect(isFamilyAvailable(measure, "Weight400Broken")).toBe(false);
    expect(isFamilyAvailable(measure, "NoSuchFamilyZZZ__")).toBe(false);
  });

  it("makeMeasurer 用 2d 上下文：设 font 后量拉丁串", () => {
    const calls: string[] = [];
    const ctx = {
      font: "",
      measureText(this: { font: string }, text: string) {
        calls.push(this.font);
        return { width: text.length };
      },
    } as unknown as CanvasRenderingContext2D;
    const width = makeMeasurer(ctx)('700 16px "Segoe UI"');
    expect(width).toBe(LATIN.length);
    expect(calls[0]).toBe('700 16px "Segoe UI"');
  });
});

describe("可用性标注与目录回填", () => {
  it("markAvailability 逐项回填，不改变其余字段", () => {
    const options: FontPickOption[] = [
      { id: "a", group: "cjk", label: "甲", stackVar: "--font-pick-a", family: "Known Sans", generic: "sans-serif", available: null },
      { id: "b", group: "mono", label: "乙", stackVar: "--font-pick-b", family: "Weight400Broken", generic: "monospace", available: null },
    ];
    const marked = markAvailability(options, measure);
    expect(marked.map((o) => o.available)).toEqual([true, false]);
    expect(marked[0].label).toBe("甲");
    expect(marked[1].stackVar).toBe("--font-pick-b");
  });

  it("firstFamilyOf 取链里第一个族（首选族名的唯一算法）", () => {
    expect(firstFamilyOf('"HarmonyOS Sans SC", "Microsoft YaHei UI", system-ui, sans-serif')).toBe(
      "HarmonyOS Sans SC",
    );
    expect(firstFamilyOf("  Inter ,Arial")).toBe("Inter");
    expect(firstFamilyOf("")).toBe(null);
  });
});

describe("实际生效族名（逐候选取第一个真命中）", () => {
  it("候选按栈顺序取第一个命中的，而不是最后一个", () => {
    expect(firstResolvedFamily('"Segoe UI", "Known Sans"', 400, measure)).toBe("Segoe UI");
    expect(firstResolvedFamily('"Known Sans", "Segoe UI"', 400, measure)).toBe("Known Sans");
  });

  it("首选 400 挂掉 → 报下一个真命中的（选了 A 实际是 B 由此暴露）", () => {
    expect(firstResolvedFamily('"Weight400Broken", "Known Sans"', 400, measure)).toBe("Known Sans");
  });

  it("全不命中 → null（调用方显示「系统回退」）", () => {
    expect(firstResolvedFamily('"NoSuchFamilyZZZ__", "AlsoMissingQQ"', 400, measure)).toBe(null);
  });

  it("通用关键字（system-ui / sans-serif…）不是可读的族名，遇到即停", () => {
    expect(firstResolvedFamily("system-ui, sans-serif", 400, measure)).toBe(null);
    expect(firstResolvedFamily('"Known Sans", system-ui, sans-serif', 400, measure)).toBe("Known Sans");
  });

  it("splitFamilies 去引号去空白", () => {
    expect(splitFamilies(' "A" , \'B\' , C ')).toEqual(["A", "B", "C"]);
  });

  it("resolveFamilies 双字重各测一次，并报是否同族", () => {
    expect(resolveFamilies('"Known Sed", serif', measure)).toEqual({
      regular: "Known Sed",
      bold: "Known Sed",
      sameAtBothWeights: true,
    });
    // 400 挂、700 通的字体：regular 落到下一档，bold 才是它
    expect(resolveFamilies('"Weight400Broken", "Segoe UI"', measure)).toEqual({
      regular: "Segoe UI",
      bold: "Weight400Broken",
      sameAtBothWeights: false,
    });
  });
});

describe("读数文案（面向用户，中文）", () => {
  it("四个结论各说各的话", () => {
    expect(describeResolved({ regular: "Known Sans", bold: "Known Sans", sameAtBothWeights: true })).toEqual({
      regular: "Known Sans",
      bold: "Known Sans",
      hint: "",
      state: "ok",
    });
    const fallback = describeResolved({ regular: null, bold: null, sameAtBothWeights: false });
    expect(fallback.regular).toBe("系统回退");
    expect(fallback.state).toBe("fallback");
    expect(fallback.hint).toContain("本机没有这个字体");
    const split = describeResolved({ regular: "Segoe UI", bold: "Weight400Broken", sameAtBothWeights: false });
    expect(split.state).toBe("fallback");
    expect(split.hint).toContain("Weight400Broken");
    expect(split.regular).toBe("Segoe UI");
  });
});
