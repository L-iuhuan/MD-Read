/**
 * 字体面板（2026-09-30 J1 重做）：**三个独立下拉**（中文正文 / 西文与数字 / 代码），
 * 各自读写各自的持久化键（modu-font-cn / modu-font-latin / modu-font-code）。
 *
 * 为什么拆三个（用户实测原话）：单下拉装三组 optgroup，「选了哪个生效？」逻辑直觉
 * 有问题——选了到底改哪组只能靠 optgroup 归属猜 ✗；且短名文案把「Times New Roman」
 * 截成「Times New R.」✗。三 select 方案下选项文案一律完整字体名，旧的 optgroup
 * 组标题回显 hack（UX-5 refreshGroupLabels）不再需要，已删。
 *
 * 应用语义（三组互不影响）：
 *   · 正文栈 = 西文链（去尾通用族）+ 中文章 —— 西文在前：拉丁字形命中西文体，
 *     CJK 字形落到中文体；若不去掉西文链**中间**的通用族收尾，`serif`/`sans-serif`
 *     会先于中文章命中，CJK 全被浏览器默认体吃掉 ✗（CSS 栈匹配是顺序短路）。
 *   · 代码栈 = 覆写 #doc 上的 `--font-mono`（自定义属性沿子树继承，cjk.css / hljs.css
 *     的 pre/code 规则照常消费）⇒ 不必改任何 CSS 文件 ✓。
 *
 * 本文件仍**不含任何字体族名**：目录与栈都来自 index.html 骨架 + tokens.css（经
 * font-catalog 的 CSSOM 读取）；「实际生效」探测判据见 font-detect.ts。
 */
import {
  firstFamilyOf,
  genericOf,
  readStackVar,
  type FontPickGroup,
  type FontPickOption,
} from "./font-catalog";
import { describeResolved, makeMeasurer, markAvailability, resolveFamilies, type MeasureText } from "./font-detect";

/** 分组键转发出口（settings.ts 的对外签名要用；定义在 font-catalog） */
export type { FontPickGroup } from "./font-catalog";

/** 三组各自的持久化键（J1 起拆三键） */
const FONT_KEYS: Readonly<Record<FontPickGroup, string>> = {
  cjk: "modu-font-cn",
  latin: "modu-font-latin",
  mono: "modu-font-code",
};
/** 旧单键（三组共用一个下拉时代的值）与更早的 modu-face：只在三新键齐缺时迁移一次 */
const LEGACY_FONT_KEY = "modu-font";
const LEGACY_FACE_KEY = "modu-face";

/** 各组默认项 = tokens.css 全局栈的首选（--font-sans / --font-mono 的头名） */
const DEFAULT_IDS: Readonly<Record<FontPickGroup, string>> = {
  cjk: "cjk-harmonyos",
  latin: "latin-segoe",
  mono: "mono-maple-nf",
};

/** 旧 modu-font 四预设值 → 新目录项（sans 仍指默认栈，不是某个具体预设） */
const LEGACY_IDS: Readonly<Record<string, string>> = {
  serif: "cjk-notoserif",
  kai: "cjk-lxgw",
  hei: "cjk-yahei",
};

const GROUPS: readonly FontPickGroup[] = ["cjk", "latin", "mono"];

/** 组 → 面板里的 select id（index.html 三下拉骨架） */
const SELECT_IDS: Readonly<Record<FontPickGroup, string>> = {
  cjk: "set-font-cn",
  latin: "set-font-latin",
  mono: "set-font-code",
};

/** 面板钩子：壳层提供 #doc 与排版重算 */
export interface FontPickerHooks {
  /** 取正文容器 #doc（字体栈的落点） */
  getDoc(): HTMLElement | null;
  /** 字体变化后重算排版（字体度量变了，断行与公式缩放要重跑） */
  onFontChange(): void;
  /**
   * 可选的量器注入点：**只给测试用**。缺省走真实 canvas（jsdom 里 getContext 返回
   * null，探测会整体降级为「不显示读数」，所以测试必须能塞一张假字宽表进来）。
   * 生产调用点从不传它。
   */
  measure?: MeasureText;
}

/** 探测量器缓存：整个会话共用一块 1×1 canvas */
let measurer: MeasureText | null = null;

/** 取（或造）探测量器；拿不到 2d 上下文时返回 null，调用方降级为「不显示读数」 */
function getMeasurer(hooks: FontPickerHooks): MeasureText | null {
  if (hooks.measure !== undefined) return hooks.measure; // 测试注入优先
  if (measurer !== null) return measurer;
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx === null) return null;
  measurer = makeMeasurer(ctx);
  return measurer;
}

/**
 * 目录：三个 select 骨架（data-group 声明分组）+ tokens.css 的栈变量。
 * （font-catalog.readFontCatalog 认旧单下拉 #set-font，J1 起骨架换了 ⇒ 本文件自查；
 *   栈变量读取 / 首选族 / 通用族等纯函数仍复用 font-catalog ✓。）
 * @throws 骨架缺失或某个 `--font-pick-*` 读不到值——目录是本面板的唯一事实源，
 *         坏了必须在控制台立刻可见，不做静默降级
 */
export function readCatalog(): FontPickOption[] {
  const options: FontPickOption[] = [];
  for (const group of GROUPS) {
    const select = document.getElementById(SELECT_IDS[group]);
    if (!(select instanceof HTMLSelectElement)) {
      throw new Error("字体设置未就绪，请重启墨读");
    }
    for (const option of select.querySelectorAll("option")) {
      const stackVar = option.dataset.stackVar ?? "";
      if (!stackVar.startsWith("--font-pick-")) {
        throw new Error(`字体选项 ${option.value} 缺少栈变量声明`);
      }
      const stack = readStackVar(stackVar);
      const family = firstFamilyOf(stack);
      if (stack === "" || family === null) {
        throw new Error(`字体栈变量读不到值：${stackVar}（tokens.css 是否漏了这条声明？）`);
      }
      options.push({
        id: option.value,
        group,
        label: (option.dataset.label ?? option.textContent ?? option.value).trim(),
        stackVar,
        family,
        generic: genericOf(stack),
        available: null,
      });
    }
  }
  if (options.length === 0) {
    throw new Error("字体列表为空，请重启墨读");
  }
  return options;
}

/**
 * 旧键迁移（一次性）：三新键齐缺而旧键在 ⇒ 旧值按其所属组写入对应新键，
 * 其余两组用默认值；随后旧键（modu-font / modu-face）退役，双源归一。
 */
function migrateLegacyPicks(): void {
  const hasNew = GROUPS.some((g) => localStorage.getItem(FONT_KEYS[g]) !== null);
  const rawFont = localStorage.getItem(LEGACY_FONT_KEY);
  const rawFace = localStorage.getItem(LEGACY_FACE_KEY);
  if (!hasNew && rawFont === null && rawFace === null) {
    return; // 全新装机：无旧可迁
  }
  let hit: FontPickOption | undefined;
  if (!hasNew) {
    // modu-face=serif 只在 modu-font 缺失时作存量回退（与旧实现同口径）
    const raw = rawFont ?? (rawFace === "serif" ? "serif" : null);
    const id = raw === null ? null : (LEGACY_IDS[raw] ?? raw);
    hit = id === null ? undefined : readCatalog().find((o) => o.id === id);
  }
  for (const g of GROUPS) {
    if (localStorage.getItem(FONT_KEYS[g]) === null) {
      localStorage.setItem(FONT_KEYS[g], hit !== undefined && hit.group === g ? hit.id : DEFAULT_IDS[g]);
    }
  }
  localStorage.removeItem(LEGACY_FONT_KEY);
  localStorage.removeItem(LEGACY_FACE_KEY);
}

/** 读某组的持久化选择（含旧键一次性迁移；坏值/跨组脏值回退该组默认项） */
export function readFontPref(group: FontPickGroup): string {
  migrateLegacyPicks();
  const raw = localStorage.getItem(FONT_KEYS[group]);
  const hit = raw === null ? undefined : readCatalog().find((o) => o.group === group && o.id === raw);
  return hit === undefined ? DEFAULT_IDS[group] : hit.id;
}

function optionOf(group: FontPickGroup, id: string): FontPickOption {
  const catalog = readCatalog();
  const fallback = catalog.find((o) => o.id === DEFAULT_IDS[group]) ?? catalog[0];
  return catalog.find((o) => o.group === group && o.id === id) ?? fallback;
}

/** 去掉链尾的通用族（组合正文栈时西文链必须让路给中文章，见文件头注释） */
function stripTrailingGeneric(stack: string): string {
  return stack.replace(/\s*,\s*(?:sans-serif|serif|monospace)\s*$/i, "");
}

/** 应用三组选择到 #doc：正文栈 = 西文链(去尾) + 中文章；代码栈覆写 --font-mono */
export function applyFontPrefs(hooks: FontPickerHooks): void {
  const doc = hooks.getDoc();
  if (doc === null) return;
  const latin = readStackVar(optionOf("latin", readFontPref("latin")).stackVar);
  const cjk = readStackVar(optionOf("cjk", readFontPref("cjk")).stackVar);
  const mono = readStackVar(optionOf("mono", readFontPref("mono")).stackVar);
  delete doc.dataset.face; // 旧衬线档契约退役：三组组合永远走内联栈
  doc.style.fontFamily = `${stripTrailingGeneric(latin)}, ${cjk}`;
  doc.style.setProperty("--font-mono", mono); // 子树继承 ⇒ pre/code 照常消费
}

/** 目录 + 可用性 → 三个下拉各自标注（只写回文案与「· 未装」标记，重复渲染安全） */
export function renderFontPicker(hooks: FontPickerHooks): FontPickOption[] {
  const measure = getMeasurer(hooks);
  const plain = readCatalog();
  const options = measure === null ? plain : markAvailability(plain, measure);
  const byId = new Map(options.map((option) => [option.id, option]));
  for (const group of GROUPS) {
    const select = document.getElementById(SELECT_IDS[group]);
    if (!(select instanceof HTMLSelectElement)) continue;
    for (const el of select.querySelectorAll("option")) {
      const option = byId.get(el.value);
      if (option === undefined) continue;
      el.dataset.label = option.label; // 完整名留档，重渲染不会叠加「· 未装」
      el.dataset.generic = option.generic;
      el.textContent = option.available === false ? `${option.label} · 未装` : option.label;
      if (option.available === false) el.dataset.unavailable = "true";
    }
  }
  syncFontSelects();
  return options;
}

/** 三下拉回显各自键的当前值；select 的 title 挂当前完整名（截断兜底 ✓） */
export function syncFontSelects(): void {
  for (const group of GROUPS) {
    const select = document.getElementById(SELECT_IDS[group]);
    if (!(select instanceof HTMLSelectElement)) continue;
    const id = readFontPref(group);
    select.value = id;
    const hit = readCatalog().find((o) => o.id === id);
    if (hit !== undefined) select.title = hit.label;
  }
}

/** 刷新「实际生效字体」：按当前正文栈在 400 / 700 两个字重上各探测一次 */
export function refreshEffective(hooks: FontPickerHooks): void {
  const code = document.getElementById("set-font-effective");
  const codeBold = document.getElementById("set-font-effective-bold");
  const hint = document.getElementById("set-font-hint");
  if (code === null || codeBold === null || hint === null) return;
  const measure = getMeasurer(hooks);
  if (measure === null) {
    code.textContent = "无法探测";
    hint.textContent = "本机图形环境不支持字体探测，已按回退链正常显示";
    hint.dataset.state = "fallback";
    return;
  }
  const doc = hooks.getDoc();
  const stack = doc === null ? "" : getComputedStyle(doc).fontFamily;
  const text = describeResolved(resolveFamilies(stack, measure));
  // ⚠ 文本**一字不改**（settings.spec.ts 的锚钉的就是这两串 ✗ 别动它们 ✓）
  code.textContent = `400 · ${text.regular}`;
  codeBold.textContent = `700 · ${text.bold}`;
  // 两个字重同族时隐藏第二行（CSS 在第一行尾部补「· 700 同」）；不同才占两行
  const boldSame = text.regular === text.bold;
  codeBold.hidden = boldSame;
  code.dataset.boldSame = boldSame ? "1" : "0";
  // 提示只在有话说时显示（「选了 A、实际渲染成 B」的解释），无异常不打扰
  hint.textContent = text.hint;
  hint.dataset.state = text.state;
}

/** 挂载字体面板：填目录 → 恢复选择 → 接 change → 亮出实际生效 */
export function mountFontPicker(hooks: FontPickerHooks): void {
  renderFontPicker(hooks);
  applyFontPrefs(hooks); // 启动恢复：#doc 常驻 index.html，落容器上即可
  for (const group of GROUPS) {
    const select = document.getElementById(SELECT_IDS[group]);
    if (!(select instanceof HTMLSelectElement)) {
      console.error(`界面元素缺失：#${SELECT_IDS[group]}`); // A4：技术细节只进 console
      throw new Error("界面资源未就绪，请重启墨读");
    }
    select.addEventListener("change", () => setFontPref(group, select.value, hooks));
  }
  refreshEffective(hooks);
}

/** 统一入口：应用 + 持久化（该组键）+ 回显 + 刷新读数（面板只有这一个写入口） */
export function setFontPref(group: FontPickGroup, id: string, hooks: FontPickerHooks): void {
  const hit = readCatalog().find((o) => o.group === group && o.id === id);
  localStorage.setItem(FONT_KEYS[group], hit === undefined ? DEFAULT_IDS[group] : hit.id);
  migrateLegacyPicks(); // 旧键退役（双源归一）
  applyFontPrefs(hooks);
  syncFontSelects();
  refreshEffective(hooks);
  hooks.onFontChange();
}
