/**
 * 「Aa」设置面板（M2 波3，用户反馈：字体是否考虑可以切换或者设置）。
 * 契约：①字号步进 14–20px 改 --fs-body（唯一作用点），modu-fs 持久化、
 * 启动恢复；②字体族四预设落到 #doc（serif 走 data-face 既有契约，
 * kai/hei 内联栈），modu-font 持久化并迁移旧 modu-face；③主题三档
 * （亮/暗/自动）下拉接线（状态机契约在 theme.spec.ts）；
 * ④行宽 40–60em 步进 2 改 --me-width，modu-width 持久化；
 * ⑤点外立即关闭（用户语义纠正，fix-15 的 focusout 延时关已移除）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  setupSettings,
  setFontPref,
  syncSettingsPanel,
  clampFs,
  readFontPref,
  readAutosavePref,
  clampWidth,
} from "../src/ui/settings";
import { applyThemePref } from "../src/ui/theme";

function mountPanel(): void {
  document.body.innerHTML = `
    <button id="btn-settings" type="button">Aa</button>
    <div id="settings-panel" hidden>
      <button id="set-fs-dec" type="button">−</button>
      <span id="set-fs-val">16</span>
      <button id="set-fs-inc" type="button">＋</button>
      <button id="set-width-dec" type="button">−</button>
      <span id="set-width-val">46</span>
      <button id="set-width-inc" type="button">＋</button>
      <select id="set-font">
        <option value="sans">微软雅黑</option>
        <option value="serif">宋体（衬线）</option>
        <option value="kai">楷体</option>
        <option value="hei">黑体</option>
      </select>
      <select id="set-theme">
        <option value="light">浅色</option>
        <option value="dark">深色</option>
        <option value="auto">自动（跟随系统）</option>
      </select>
      <input id="set-autosave" type="checkbox" />
    </div>
    <article id="doc" class="mdc"></article>`;
}

function setup(): ReturnType<typeof vi.fn>[] {
  const onFontChange = vi.fn();
  setupSettings({
    getDoc: () => document.getElementById("doc"),
    onFontChange,
  });
  return [onFontChange];
}

function fsVar(): string {
  return document.documentElement.style.getPropertyValue("--fs-body");
}

function widthVar(): string {
  return document.documentElement.style.getPropertyValue("--me-width");
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--fs-body");
  document.documentElement.style.removeProperty("--me-width");
  delete document.documentElement.dataset.theme;
  mountPanel();
});

describe("字号步进（14–20px）", () => {
  it("clampFs 钳制到 [14, 20]", () => {
    expect(clampFs(10)).toBe(14);
    expect(clampFs(26)).toBe(20);
    expect(clampFs(16.4)).toBe(16); // 四舍五入到整数 px
  });

  it("＋ 步进：写 --fs-body、回显数值、持久化 modu-fs", () => {
    setup();
    document.getElementById("set-fs-inc")?.click();
    expect(fsVar()).toBe("17px");
    expect(document.getElementById("set-fs-val")?.textContent).toBe("17");
    expect(localStorage.getItem("modu-fs")).toBe("17");
  });

  it("上下界不再增减（20 封顶 / 14 保底）", () => {
    localStorage.setItem("modu-fs", "20");
    setup();
    document.getElementById("set-fs-inc")?.click();
    expect(fsVar()).toBe("20px");
    localStorage.setItem("modu-fs", "14");
    setup();
    document.getElementById("set-fs-dec")?.click();
    expect(fsVar()).toBe("14px");
  });

  it("启动恢复：modu-fs=18 → --fs-body 与回显均为 18", () => {
    localStorage.setItem("modu-fs", "18");
    setup();
    expect(fsVar()).toBe("18px");
    expect(document.getElementById("set-fs-val")?.textContent).toBe("18");
  });

  it("坏值回退默认 16（与 tokens --fs-body 同值）", () => {
    localStorage.setItem("modu-fs", "abc");
    setup();
    expect(fsVar()).toBe("16px");
  });
});

describe("字体族预设", () => {
  it("kai → #doc 内联楷体栈，modu-font 持久化", () => {
    setup();
    const select = document.getElementById("set-font") as HTMLSelectElement;
    select.value = "kai";
    select.dispatchEvent(new Event("change"));
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.fontFamily).toContain("KaiTi");
    expect(doc.dataset.face).toBeUndefined();
    expect(localStorage.getItem("modu-font")).toBe("kai");
  });

  it("serif → 走 #doc[data-face] 契约（清内联栈）", () => {
    setup();
    const select = document.getElementById("set-font") as HTMLSelectElement;
    select.value = "serif";
    select.dispatchEvent(new Event("change"));
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.dataset.face).toBe("serif");
    expect(doc.style.fontFamily).toBe("");
  });

  it("回 sans：清 data-face 与内联栈；旧键 modu-face 迁移后退役", () => {
    localStorage.setItem("modu-face", "serif");
    expect(readFontPref()).toBe("serif"); // 存量迁移回退
    setup();
    setFontPref("sans");
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.dataset.face).toBeUndefined();
    expect(doc.style.fontFamily).toBe("");
    expect(localStorage.getItem("modu-font")).toBe("sans");
    expect(localStorage.getItem("modu-face")).toBe(null);
  });

  it("启动恢复：modu-font=hei → 面板回显并应用到 #doc", () => {
    localStorage.setItem("modu-font", "hei");
    setup();
    const doc = document.getElementById("doc") as HTMLElement;
    expect(doc.style.fontFamily).toContain("SimHei");
    expect((document.getElementById("set-font") as HTMLSelectElement).value).toBe("hei");
  });

  it("字体变化触发 onFontChange 钩子（壳层重算排版）", () => {
    const [onFontChange] = setup();
    setFontPref("kai");
    expect(onFontChange).toHaveBeenCalled();
  });
});

describe("主题下拉（三档接线，状态机在 ui/theme.ts）", () => {
  it("选深色 → html[data-theme=dark] + modu-theme 持久化", () => {
    setup();
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "dark";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("modu-theme")).toBe("dark");
  });

  it("选自动 → modu-theme=auto，data-theme 按系统解析（jsdom 无 matchMedia → 亮）", () => {
    setup();
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "auto";
    select.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("modu-theme")).toBe("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(select.value).toBe("auto"); // 下拉回显三档偏好本身，非解析值
  });

  it("启动同步当前偏好（modu-theme=auto → 下拉回显自动）", () => {
    localStorage.setItem("modu-theme", "auto");
    setup();
    expect((document.getElementById("set-theme") as HTMLSelectElement).value).toBe("auto");
  });
});

describe("行宽步进（40–60em 步进 2，用户反馈批次）", () => {
  it("clampWidth 钳制到 [40,60] 并吸附 2 的倍数", () => {
    expect(clampWidth(38)).toBe(40); // 下界外拉回
    expect(clampWidth(62)).toBe(60); // 上界外拉回
    expect(clampWidth(45)).toBe(46); // 奇数吸附到偶数档
    expect(clampWidth(41.4)).toBe(42);
  });

  it("＋ 步进：写 --me-width、回显数值、持久化 modu-width", () => {
    setup();
    document.getElementById("set-width-inc")?.click();
    expect(widthVar()).toBe("48");
    expect(document.getElementById("set-width-val")?.textContent).toBe("48");
    expect(localStorage.getItem("modu-width")).toBe("48");
  });

  it("上下界不再增减（60 封顶 / 40 保底）", () => {
    localStorage.setItem("modu-width", "60");
    setup();
    document.getElementById("set-width-inc")?.click();
    expect(widthVar()).toBe("60");
    localStorage.setItem("modu-width", "40");
    setup();
    document.getElementById("set-width-dec")?.click();
    expect(widthVar()).toBe("40");
  });

  it("启动恢复：modu-width=52 → --me-width 与回显均为 52；坏值回退 46", () => {
    localStorage.setItem("modu-width", "52");
    setup();
    expect(widthVar()).toBe("52");
    expect(document.getElementById("set-width-val")?.textContent).toBe("52");
    localStorage.setItem("modu-width", "abc");
    setup();
    expect(widthVar()).toBe("46");
  });
});

describe("回显同步（波5起：◐ 按钮与面板同源，外部改后 sync 不陈旧）", () => {
  it("外部（◐）改主题后 syncSettingsPanel：下拉回显三档偏好", () => {
    setup();
    applyThemePref("auto"); // 模拟面板外改主题（◐ 循环到自动档）
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    expect(select.value).toBe("auto"); // applyThemePref 已即时回显
    select.value = "light"; // 人为制造陈旧
    syncSettingsPanel();
    expect(select.value).toBe("auto");
  });

  it("面板打开时自调 sync：外部改主题后再点 Aa，回显不陈旧", () => {
    setup();
    applyThemePref("dark");
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "light"; // 制造陈旧
    document.getElementById("btn-settings")?.click(); // 打开面板 → 触发自调
    expect(select.value).toBe("dark");
  });
});

describe("面板开关", () => {
  it("Aa 按钮切换 settings-panel 显隐", () => {
    setup();
    const panel = document.getElementById("settings-panel") as HTMLElement;
    expect(panel.hidden).toBe(true);
    document.getElementById("btn-settings")?.click();
    expect(panel.hidden).toBe(false);
    document.getElementById("btn-settings")?.click();
    expect(panel.hidden).toBe(true);
  });
});

/* ---- 自动保存开关（用户反馈批次）：modu-autosave 持久化、默认开 ---- */

describe("自动保存开关", () => {
  it("默认开：无记录 readAutosavePref=true，面板勾选框回显 checked", () => {
    setup();
    expect(readAutosavePref()).toBe(true);
    expect((document.getElementById("set-autosave") as HTMLInputElement).checked).toBe(true);
  });

  it("modu-autosave=off → 关且面板回显未勾；坏值也当开", () => {
    localStorage.setItem("modu-autosave", "off");
    setup();
    expect(readAutosavePref()).toBe(false);
    expect((document.getElementById("set-autosave") as HTMLInputElement).checked).toBe(false);
    localStorage.setItem("modu-autosave", "乱码");
    expect(readAutosavePref()).toBe(true);
  });

  it("面板切换写回 localStorage（off ↔ on）", () => {
    setup();
    const box = document.getElementById("set-autosave") as HTMLInputElement;
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("modu-autosave")).toBe("off");
    expect(readAutosavePref()).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(localStorage.getItem("modu-autosave")).toBe("on");
  });
});

/* ---- Aa 面板点外关闭（用户反馈批次·语义纠正）：与最近菜单同款 document 点击委托，
 *      fix-15 的 focusout 延时自动关已按用户语义移除（点外立即关，无任何计时） ---- */

describe("Aa 面板点外关闭", () => {
  function openPanel(): HTMLElement {
    setup();
    document.getElementById("btn-settings")?.click();
    return document.getElementById("settings-panel") as HTMLElement;
  }

  it("点击面板与 Aa 钮之外的任意处 → 立即关闭（无延时）", () => {
    const panel = openPanel();
    (document.getElementById("doc") as HTMLElement).click();
    expect(panel.hidden).toBe(true);
  });

  it("点击面板内部控件不关；Aa 钮再点一次走手动开关（toggle 关）", () => {
    const panel = openPanel();
    document.getElementById("set-fs-inc")?.click(); // 面板内点击
    expect(panel.hidden).toBe(false);
    document.getElementById("btn-settings")?.click(); // Aa 钮 = 手动开关
    expect(panel.hidden).toBe(true);
  });

  it("面板关着时点外部无副作用（不会误开）", () => {
    setup();
    (document.getElementById("doc") as HTMLElement).click();
    expect((document.getElementById("settings-panel") as HTMLElement).hidden).toBe(true);
  });
});
