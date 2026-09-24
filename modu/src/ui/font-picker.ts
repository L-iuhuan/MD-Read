/**
 * 字体面板（D-02 第二步）：① 推荐列表（中文正文 / 西文拉丁 / 代码三组）
 * + ③ 常显「实际生效字体」。
 *
 * 本文件同样**不含任何字体族名**：选项文案与栈都来自 index.html 骨架 + tokens.css 目录。
 *
 * 常显读数为什么必须存在：CSS 字体栈是**静默回退**——字体缺失不报错、不警告、
 * 控制台无痕。没有这一行，「选了 A 实际渲染 B」永远无人发现（本会话就是这么
 * 埋了 `Noto Sans SC`：注册表/GDI 都能枚举，400 字重却一直悄悄回退）。
 * 探测判据见 font-detect.ts（拉丁串 + 双字重 + 双假名基线）。
 */
import { firstFamilyOf, readFontCatalog, readStackVar, stackVarRef, type FontPickOption } from "./font-catalog";
import { describeResolved, makeMeasurer, markAvailability, resolveFamilies, type MeasureText } from "./font-detect";

/** 持久化键；**与旧值兼容**：sans/serif/kai/hei 会被 resolveFontId 迁到对应新选项 */
const FONT_KEY = "modu-font";
/** M2 波2 起的旧键 modu-face=serif：只在 modu-font 缺失时作为存量回退，写入新值后退役 */
const LEGACY_FACE_KEY = "modu-face";

/** 「旧 modu-font 值 → 新目录 id」迁移表；sans 仍指默认栈（不是某个具体预设） */
const LEGACY_IDS: Readonly<Record<string, string>> = {
  sans: "sans",
  serif: "cjk-notoserif",
  kai: "cjk-lxgw",
  hei: "cjk-yahei",
};

/** 缺省选中项：默认无衬线栈的首选（HarmonyOS Sans SC） */
const DEFAULT_ID = "cjk-harmonyos";

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

/** 当前选择解析出的目录项；无法解析时返回默认项的兜底对象 */
interface ResolvedPick {
  id: string;
  /** 要内联给 #doc 的字体栈值；`sans` 表示清内联、回 tokens.css 的 --font-sans */
  stackVar: string | null;
  /** true = 走 #doc[data-face="serif"] 既有契约（cjk.css 的 --font-serif） */
  serif: boolean;
  label: string;
}

/** 该选项是否该走 `#doc[data-face="serif"]` 契约（首选族 == --font-serif 的首选族） */
function usesSerifFace(option: FontPickOption): boolean {
  return option.generic === "serif" && option.family === firstFamilyOf(readStackVar("--font-serif"));
}

/**
 * 把任意持久化值解析成可应用的选择。
 *
 * 衬线档契约（`#doc[data-face="serif"]` → cjk.css 的 --font-serif）只在
 * **选项自己的首选族就是 --font-serif 的首选**时才用，否则内联该选项自己的链。
 * 为什么不能只看「通用族是不是 serif」：`霞鹜文楷` / `Georgia` / `Times` 也是
 * serif 收尾，但它们各自链的**首选**不是 Noto Serif SC——套用全局衬线栈会把它们
 * 渲染成 Noto Serif SC（「选了 A 实际是 B」，正是本面板要消灭的东西）。
 * 旧 modu-face=serif 的存量迁移必须落到 --font-serif 的首要选择上（LEGACY_IDS
 * 把它映射到 cjk-notoserif），所以那条路径仍然命中契约。
 *
 * @param raw localStorage 里的原值（可能缺失 / 旧值 / 脏值）
 */
export function resolvePick(raw: string | null): ResolvedPick {
  const options = readFontCatalog();
  const viaLegacy = raw === null ? (localStorage.getItem(LEGACY_FACE_KEY) === "serif" ? "serif" : null) : raw;
  const id = viaLegacy === null ? DEFAULT_ID : (LEGACY_IDS[viaLegacy] ?? viaLegacy);
  if (id === "sans") {
    return { id, stackVar: null, serif: false, label: "默认（随主题）" };
  }
  const option = options.find((item) => item.id === id) ?? options.find((item) => item.id === DEFAULT_ID) ?? options[0];
  return {
    id: option.id,
    stackVar: stackVarRef(option),
    serif: usesSerifFace(option),
    label: option.label,
  };
}

/** 读持久化选择（含旧值迁移；坏值回退默认项） */
export function readFontPref(): string {
  return resolvePick(localStorage.getItem(FONT_KEY)).id;
}

/** 应用选择到 #doc：衬线档走 data-face 契约，其余落内联 var(--font-pick-*) */
export function applyFontPref(id: string, hooks: FontPickerHooks): void {
  const doc = hooks.getDoc();
  if (doc === null) return;
  const pick = resolvePick(id);
  if (pick.stackVar === null) {
    delete doc.dataset.face;
    doc.style.removeProperty("font-family");
    return;
  }
  if (pick.serif) {
    doc.style.removeProperty("font-family");
    doc.dataset.face = "serif";
    return;
  }
  delete doc.dataset.face;
  doc.style.fontFamily = pick.stackVar;
}

/** 目录 + 可用性 → 在下拉骨架上标注（保留 index.html 的 optgroup / option 结构，
 *  只写回文案与「本机未安装」标记，重复渲染安全） */
export function renderFontPicker(select: HTMLSelectElement, hooks: FontPickerHooks): FontPickOption[] {
  const measure = getMeasurer(hooks);
  const plain = readFontCatalog();
  const options = measure === null ? plain : markAvailability(plain, measure);
  const byId = new Map(options.map((option) => [option.id, option]));
  for (const el of select.querySelectorAll("option")) {
    const option = byId.get(el.value);
    if (option === undefined) continue;
    el.dataset.label = option.label; // 原始中文名留档，重渲染不会叠加标注
    el.dataset.generic = option.generic; // 通用族（衬线档契约据此判定）
    el.textContent = option.available === false ? `${option.label}（本机未安装）` : option.label;
    if (option.available === false) el.dataset.unavailable = "true";
  }
  return options;
}

/** 刷新「实际生效字体」：按当前选择在 400 / 700 两个字重上各探测一次 */
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
  const pick = resolvePick(localStorage.getItem(FONT_KEY));
  code.textContent = `400 · ${text.regular}`;
  codeBold.textContent = `700 · ${text.bold}`;
  hint.textContent = text.hint === "" ? `当前选择：${pick.label}` : `${pick.label}：${text.hint}`;
  hint.dataset.state = text.state;
}

/** 挂载字体面板：填目录 → 恢复选择 → 接 change → 亮出实际生效 */
export function mountFontPicker(hooks: FontPickerHooks): void {
  const select = document.getElementById("set-font");
  if (!(select instanceof HTMLSelectElement)) {
    console.error("界面元素缺失：#set-font"); // A4：技术细节只进 console，使用者只看下一行
    throw new Error("界面资源未就绪，请重启墨读");
  }
  renderFontPicker(select, hooks);
  select.value = readFontPref();
  applyFontPref(readFontPref(), hooks); // 启动恢复：#doc 常驻 index.html，落容器上即可
  select.addEventListener("change", () => setFontPref(select.value, hooks));
  refreshEffective(hooks);
}

/** 统一入口：应用 + 持久化 + 回显 + 刷新读数（面板只有这一个写入口） */
export function setFontPref(id: string, hooks: FontPickerHooks): void {
  applyFontPref(id, hooks);
  const pick = resolvePick(id);
  localStorage.setItem(FONT_KEY, pick.id);
  localStorage.removeItem(LEGACY_FACE_KEY); // 双源归一，旧键退役
  const select = document.getElementById("set-font");
  if (select instanceof HTMLSelectElement) select.value = pick.id;
  refreshEffective(hooks);
  hooks.onFontChange();
}
