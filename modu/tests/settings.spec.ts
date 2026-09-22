/**
 * 「Aa」设置面板（M2 波3，用户反馈：字体是否考虑可以切换或者设置）。
 * 契约：①字号步进 14–20px 改 --fs-body（唯一作用点），modu-fs 持久化、
 * 启动恢复；②字体族四预设落到 #doc（serif 走 data-face 既有契约，
 * kai/hei 内联栈），modu-font 持久化并迁移旧 modu-face；③主题亮暗入面板。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  setupSettings,
  setFontPref,
  syncSettingsPanel,
  clampFs,
  readFontPref,
  readAutosavePref,
  PANEL_AUTO_CLOSE_MS,
} from "../src/ui/settings";

function mountPanel(): void {
  document.body.innerHTML = `
    <button id="btn-settings" type="button">Aa</button>
    <div id="settings-panel" hidden>
      <button id="set-fs-dec" type="button">−</button>
      <span id="set-fs-val">16</span>
      <button id="set-fs-inc" type="button">＋</button>
      <select id="set-font">
        <option value="sans">微软雅黑</option>
        <option value="serif">宋体（衬线）</option>
        <option value="kai">楷体</option>
        <option value="hei">黑体</option>
      </select>
      <select id="set-theme">
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
      <input id="set-autosave" type="checkbox" />
    </div>
    <article id="doc" class="mdc"></article>`;
}

function setup(): ReturnType<typeof vi.fn>[] {
  const onFontChange = vi.fn();
  const onThemeChange = vi.fn();
  setupSettings({
    getDoc: () => document.getElementById("doc"),
    onFontChange,
    onThemeChange,
  });
  return [onFontChange, onThemeChange];
}

function fsVar(): string {
  return document.documentElement.style.getPropertyValue("--fs-body");
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.style.removeProperty("--fs-body");
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

describe("主题入面板", () => {
  it("选深色 → html[data-theme=dark] + modu-theme 持久化 + onThemeChange", () => {
    const [, onThemeChange] = setup();
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    select.value = "dark";
    select.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("modu-theme")).toBe("dark");
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("启动同步当前主题（data-theme=dark → 下拉回显深色）", () => {
    document.documentElement.dataset.theme = "dark";
    setup();
    expect((document.getElementById("set-theme") as HTMLSelectElement).value).toBe("dark");
  });
});

describe("回显同步（波5：◐ 按钮与面板不同步修复）", () => {
  it("外部改 data-theme 后 syncSettingsPanel：主题下拉回显与 data-theme 一致", () => {
    setup();
    // 模拟面板开着时点 ◐：html 直改主题，面板下拉仍是旧值（陈旧）
    document.documentElement.dataset.theme = "dark";
    const select = document.getElementById("set-theme") as HTMLSelectElement;
    expect(select.value).toBe("light"); // 未 sync 前确为陈旧
    syncSettingsPanel();
    const actual = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    expect(select.value).toBe(actual);
    expect(select.value).toBe("dark");
  });

  it("面板打开时自调 sync：外部改主题后再点 Aa，回显不陈旧", () => {
    setup();
    document.documentElement.dataset.theme = "dark"; // 外部（◐）已切深色
    document.getElementById("btn-settings")?.click(); // 打开面板 → 触发自调
    expect((document.getElementById("set-theme") as HTMLSelectElement).value).toBe("dark");
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

/* ---- Aa 面板自动关（用户反馈批次）：变更 + 整体失焦后 800ms 收起 ---- */

describe("Aa 面板自动关（focusout 判定）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function openPanel(): HTMLElement {
    setup();
    document.getElementById("btn-settings")?.click();
    return document.getElementById("settings-panel") as HTMLElement;
  }

  /** 模拟面板失焦：relatedTarget 是焦点落点（面板外 = 真失焦） */
  function blurPanel(panel: HTMLElement, to: Node): void {
    panel.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: to }));
  }

  it("字号变更 + 整体失焦 → 800ms 后自动收起（窗口内仍在）", () => {
    const panel = openPanel();
    document.getElementById("set-fs-inc")?.click(); // 变更①：字号步进
    blurPanel(panel, document.body);
    expect(panel.hidden).toBe(false); // 800ms 内还开着
    vi.advanceTimersByTime(PANEL_AUTO_CLOSE_MS);
    expect(panel.hidden).toBe(true);
  });

  it("连续点步进（焦点始终在面板内）→ 不关", () => {
    const panel = openPanel();
    document.getElementById("set-fs-inc")?.click();
    const inc = document.getElementById("set-fs-inc") as HTMLElement;
    blurPanel(panel, inc); // relatedTarget 在面板内：只是焦点挪到下一档按钮
    vi.advanceTimersByTime(PANEL_AUTO_CLOSE_MS * 2);
    expect(panel.hidden).toBe(false);
  });

  it("字体/主题变更同样计入「有过变更」：失焦后收起", () => {
    const panel = openPanel();
    const font = document.getElementById("set-font") as HTMLSelectElement;
    font.value = "kai";
    font.dispatchEvent(new Event("change"));
    const theme = document.getElementById("set-theme") as HTMLSelectElement;
    theme.value = "dark";
    theme.dispatchEvent(new Event("change"));
    blurPanel(panel, document.body);
    vi.advanceTimersByTime(PANEL_AUTO_CLOSE_MS);
    expect(panel.hidden).toBe(true);
  });

  it("未变更过：失焦也不自动关（面板留着对比）", () => {
    const panel = openPanel();
    blurPanel(panel, document.body);
    vi.advanceTimersByTime(PANEL_AUTO_CLOSE_MS * 2);
    expect(panel.hidden).toBe(false);
  });

  it("失焦计时中焦点回面板（focusin）→ 取消关闭", () => {
    const panel = openPanel();
    document.getElementById("set-fs-inc")?.click();
    blurPanel(panel, document.body);
    vi.advanceTimersByTime(PANEL_AUTO_CLOSE_MS / 2);
    panel.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(PANEL_AUTO_CLOSE_MS);
    expect(panel.hidden).toBe(false);
  });
});
