/**
 * 字体命中探测（D-02 第二步）——「实际生效字体」唯一的判据。
 *
 * 三条判据都是本会话实测踩出来的，别改回去：
 *   ① **必须用拉丁串**：汉字在所有中文字体里都是 1em 宽，中文串量不出任何差别
 *      （`Noto Sans SC` 用中文串测「命中」，用拉丁串测才知道 400 是静默回退）；
 *   ② **必须按真实字重测**：`Noto Sans SC` 在 400 失败、700 成功，只测默认字重
 *      会把「正文一直回退」误判成可用；
 *   ③ **基线取两个不存在的族名**并要求同时不等：否则「随手编的假族名恰好解析成
 *      某个真字体」会让所有候选都被判命中（假阳性）。
 *
 * 纯函数 + 注入 MeasureText，不碰 DOM，jsdom 里可直接单测。
 */
import type { FontPickOption } from "./font-catalog";

/** canvas 字宽探测的最小依赖：给一个 font 简写，回拉丁串宽度 */
export type MeasureText = (fontSpec: string) => number;

/** 只含 ASCII 的探测串：任何中文字体对它的度量都不同，且与 1em 无关 */
export const LATIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/** 两个「一定不存在」的族名：基线取两者，「假名恰好可用」的反向漏判挡在门外 */
const BOGUS_A = "NoSuchFamilyZZZ__";
const BOGUS_B = "AnotherBogusFamilyQQ__";
/** 字宽差阈值（px）：0.01 足以区分任何真实字体差异，又不会因浮点抖动误判 */
const WIDTH_EPSILON = 0.01;
/** 正文真实使用的两个字重：400 = 正文，700 = 加粗 */
export const BODY_WEIGHTS = [400, 700] as const;

/** 用 2d 上下文构造量器（浏览器里唯一入口） */
export function makeMeasurer(ctx: CanvasRenderingContext2D): MeasureText {
  return (fontSpec: string): number => {
    ctx.font = fontSpec;
    return ctx.measureText(LATIN).width;
  };
}

/** canvas 的 font 简写：`<weight> 16px "<family>"` */
function spec(weight: number, family: string): string {
  return `${weight} 16px "${family}"`;
}

/** 某个族名在**单一字重**上是否真命中（与两个假族名基线都不同才算） */
export function hitsAtWeight(measure: MeasureText, family: string, weight: number): boolean {
  const value = measure(spec(weight, family));
  const bogusA = measure(spec(weight, BOGUS_A));
  const bogusB = measure(spec(weight, BOGUS_B));
  return Math.abs(value - bogusA) > WIDTH_EPSILON && Math.abs(value - bogusB) > WIDTH_EPSILON;
}

/** 正文两个字重**都**命中才算可用——400 失败就是正文会静默回退 */
export function isFamilyAvailable(measure: MeasureText, family: string): boolean {
  return BODY_WEIGHTS.every((weight: number): boolean => hitsAtWeight(measure, family, weight));
}

/** 探测结果 → 回填 available 的目录副本（面板与探测共用同一份数据结构） */
export function markAvailability(
  options: readonly FontPickOption[],
  measure: MeasureText,
): FontPickOption[] {
  return options.map((option) => ({
    ...option,
    available: isFamilyAvailable(measure, option.family),
  }));
}

/** 把 computedStyle 给出的 `font-family` 列表切成候选族名数组 */
export function splitFamilies(stack: string): string[] {
  return stack
    .split(",")
    .map((raw) => raw.trim().replace(/^["']|["']$/g, ""))
    .filter((family) => family.length > 0);
}

/** CSS 通用族关键字：它们永远「命中」，但不该出现在「实际生效」的读数里 */
const GENERIC = new Set([
  "system-ui",
  "sans-serif",
  "serif",
  "monospace",
  "ui-monospace",
  "ui-serif",
  "ui-sans-serif",
  "cursive",
  "fantasy",
  "-apple-system",
]);

/**
 * 逐候选测字宽，返回**第一个真命中**的族名；全不命中返回 null（调用方显示「系统回退」）。
 * 这就是「实际生效字体」的核心：选了 A 实际是 B，这里会直接说出 B。
 */
export function firstResolvedFamily(
  stack: string,
  weight: number,
  measure: MeasureText,
): string | null {
  for (const family of splitFamilies(stack)) {
    if (GENERIC.has(family)) return null;
    if (hitsAtWeight(measure, family, weight)) return family;
  }
  return null;
}

/** 三栈探测结果：两个字重各自的「实际生效族名」 */
export interface ResolvedFamilies {
  /** 400 字重实际渲染的族名；null = 落到通用族/系统回退 */
  regular: string | null;
  /** 700 字重实际渲染的族名；null = 同上 */
  bold: string | null;
  /** 两档是否命中同一个族 */
  sameAtBothWeights: boolean;
}

/** 对一条完整字体栈做双字重探测 */
export function resolveFamilies(stack: string, measure: MeasureText): ResolvedFamilies {
  const regular = firstResolvedFamily(stack, 400, measure);
  const bold = firstResolvedFamily(stack, 700, measure);
  return { regular, bold, sameAtBothWeights: regular !== null && regular === bold };
}

/** 面板读数文案（未命中一律说「系统回退」，不写「无」这类含糊词） */
export interface ResolvedText {
  regular: string;
  bold: string;
  hint: string;
  /** 供 CSS 上色：ok / fallback / serif */
  state: "ok" | "fallback";
}

/** 把探测结果翻成面向用户的读数与提示 */
export function describeResolved(resolved: ResolvedFamilies): ResolvedText {
  const regular = resolved.regular ?? "系统回退";
  const bold = resolved.bold ?? "系统回退";
  if (resolved.regular === null) {
    return {
      regular,
      bold,
      hint: "本机没有这个字体（或它在正文 400 字重下命中不了），已按回退链显示下一档",
      state: "fallback",
    };
  }
  if (!resolved.sameAtBothWeights) {
    return {
      regular,
      bold,
      hint: `加粗时会换成 ${bold}：该字体在 700 字重下没命中，回退链在加粗处接手`,
      state: "fallback",
    };
  }
  return { regular, bold, hint: "", state: "ok" };
}
