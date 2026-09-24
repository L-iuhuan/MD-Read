/**
 * 字体推荐目录读取（D-02 第二步）。
 *
 * **事实源在页面里，不在本文件里**：字体栈与目录都写在 tokens.css 的
 * `--font-pick-<id>` 变量里，本模块只在运行时**读 CSSOM**取回它们：
 *   - 推荐项（id / 中文名 / 排序）由 index.html 的 option 骨架给出（`data-stack-var`
 *     声明它对应哪个栈变量）；
 *   - 每条栈的**完整回退链**与**首选族名**由 getComputedStyle 读 `--font-pick-<id>`
 *     得到——首选族名 = 链里的第一个族，所以「探测哪个名字」也由 tokens.css 决定。
 *
 * 于是本文件（以及任何 ui/*.ts、任何 app.css 规则）里**一个字体族名都没有**，
 * 字体栈只出现在 tokens.css 一处。
 *
 * 为什么不 `import css from "...tokens.css?raw"`：vitest 会把 CSS 模块桩成空串
 * （`theme-tokens.spec.ts` 文件头已记过这个坑），那样测试里目录会是空的、面板
 * 直接抛错。读 CSSOM 则两条通路（WebView2 / jsdom 内联样式表）都拿得到真值。
 */

/** 面板语义分组（顺序即展示顺序），对应 index.html 的三个 optgroup */
export type FontPickGroup = "cjk" | "latin" | "mono";

/** 一个推荐项：id 与中文名来自 index.html 骨架，栈与首选族名来自 tokens.css */
export interface FontPickOption {
  /** 持久化值（= option 的 value） */
  id: string;
  group: FontPickGroup;
  /** 面向用户的中文名（index.html 里写的那份） */
  label: string;
  /** tokens.css 里的字体栈变量名，形如 `--font-pick-cjk-harmonyos` */
  stackVar: string;
  /** 首选族名（探测与「实际生效」显示的唯一来源） */
  family: string;
  /** 该链收尾的 CSS 通用族（serif / sans-serif / monospace），决定衬线档契约 */
  generic: string;
  /** 首选是否在正文两个字重上都命中；null = 尚未探测 */
  available: boolean | null;
}

/** 三个 optgroup 的 `data-group` 标记就是分组键本身 */
const GROUPS: readonly FontPickGroup[] = ["cjk", "latin", "mono"];

/** data-group → 分组键（不认识即抛错，不做静默归组） */
function toGroup(mark: string | undefined): FontPickGroup {
  const found = GROUPS.find((group) => group === mark);
  if (found === undefined) {
    throw new Error(`字体分组标记不认识：${mark ?? "(缺失)"}（只认 cjk / latin / mono）`);
  }
  return found;
}

/** 从一条 CSS 值里取第一个族名（`"HarmonyOS Sans SC", "Microsoft YaHei UI", …` → HarmonyOS Sans SC） */
export function firstFamilyOf(stack: string): string | null {
  for (const raw of stack.split(",")) {
    const family = raw.trim().replace(/^["']|["']$/g, "");
    if (family.length > 0) return family;
  }
  return null;
}

/** 链收尾的 CSS 通用族；链里没有通用族说明回退链不完整，直接报错不猜 */
export function genericOf(stack: string): string {
  const matches = [...stack.matchAll(/\b(sans-serif|serif|monospace)\b/g)].map((m) => m[1]);
  const found = matches[matches.length - 1];
  if (found === undefined) {
    throw new Error(`字体栈没有以通用族收尾（回退链不完整）：${stack}`);
  }
  return found;
}

/** 取某个自定义属性的计算值（`:root` 上；读不到返回空串） */
export function readStackVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * 从 index.html 的 option 骨架 + tokens.css 的栈变量，装出完整目录。
 * @throws 骨架缺失、optgroup 名不认识、或某个 `--font-pick-*` 读不到值——
 *         目录是本面板的唯一事实源，坏了必须在控制台立刻可见，不做静默降级
 */
export function readFontCatalog(): FontPickOption[] {
  const select = document.getElementById("set-font");
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("界面元素缺失：#set-font");
  }
  const options: FontPickOption[] = [];
  for (const group of select.querySelectorAll("optgroup")) {
    const key = toGroup(group.dataset.group);
    for (const option of group.querySelectorAll("option")) {
      options.push(toOption(option, key));
    }
  }
  if (options.length === 0) {
    throw new Error("字体目录为空：#set-font 下没有可用的 option 骨架");
  }
  return options;
}

/** 单个 option 骨架 → 目录项（栈变量值缺失即抛错，不猜） */
function toOption(option: HTMLOptionElement, group: FontPickGroup): FontPickOption {
  const stackVar = option.dataset.stackVar ?? "";
  if (!stackVar.startsWith("--font-pick-")) {
    throw new Error(`字体选项 ${option.value} 缺少 data-stack-var 声明`);
  }
  const stack = readStackVar(stackVar);
  const family = firstFamilyOf(stack);
  if (stack === "" || family === null) {
    throw new Error(`字体栈变量读不到值：${stackVar}（tokens.css 是否漏了这条声明？）`);
  }
  return {
    id: option.value,
    group,
    // label 只在首次渲染时从骨架写入 data-label；后续重渲染读它，避免「（本机未安装）」被叠加多次
    label: (option.dataset.label ?? option.textContent ?? option.value).trim(),
    stackVar,
    family,
    generic: genericOf(stack),
    available: null,
  };
}

/** 该选项要内联给 #doc 的字体栈值（形如 `var(--font-pick-cjk-harmonyos)`） */
export function stackVarRef(option: FontPickOption): string {
  return `var(${option.stackVar})`;
}
