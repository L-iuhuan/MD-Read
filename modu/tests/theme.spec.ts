/**
 * 主题引擎三档（用户反馈批次·跟随系统主题）：
 * - resolvedTheme 纯函数（prefersDark 可注入）；
 * - readThemePref 坏值回退、auto 持久化读回；
 * - applyThemePref：data-theme=解析值 + modu-theme=偏好 + 下拉/◐ 回显 + 钩子；
 * - nextThemePref ◐ 循环序；watchSystemTheme 仅自动档跟随（matchMedia 桩）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPalettePref,
  applyThemePref,
  nextThemePref,
  readPalettePref,
  readThemePref,
  resolvedTheme,
  setupThemeEngine,
  watchSystemTheme,
} from "../src/ui/theme";

function mountChrome(): void {
  document.body.innerHTML = `
    <button id="btn-theme" type="button" title="切换亮暗主题">◐</button>
    <select id="set-theme">
      <option value="light">浅色</option>
      <option value="dark">深色</option>
      <option value="auto">自动（跟随系统）</option>
    </select>
    <select id="set-palette">
      <option value="dianlan">靛蓝</option>
      <option value="xuanzhi">宣纸</option>
      <option value="shimo">石墨</option>
      <option value="zidai">紫黛</option>
      <option value="qingmo">青墨</option>
    </select>`;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.palette;
  mountChrome();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolvedTheme（纯函数，prefersDark 可注入）", () => {
  it("亮/暗档直通，与系统无关", () => {
    expect(resolvedTheme("light", true)).toBe("light");
    expect(resolvedTheme("dark", false)).toBe("dark");
  });

  it("自动档跟随系统：dark→dark / light→light", () => {
    expect(resolvedTheme("auto", true)).toBe("dark");
    expect(resolvedTheme("auto", false)).toBe("light");
  });
});

describe("readThemePref", () => {
  it("无记录/坏值回退 light；三档合法值原样读回", () => {
    expect(readThemePref()).toBe("light");
    localStorage.setItem("modu-theme", "乱码");
    expect(readThemePref()).toBe("light");
    for (const pref of ["light", "dark", "auto"] as const) {
      localStorage.setItem("modu-theme", pref);
      expect(readThemePref()).toBe(pref);
    }
  });
});

describe("◐ 循环三态", () => {
  it("亮 → 暗 → 自动 → 亮", () => {
    expect(nextThemePref("light")).toBe("dark");
    expect(nextThemePref("dark")).toBe("auto");
    expect(nextThemePref("auto")).toBe("light");
  });
});

describe("applyThemePref（应用 + 持久化 + 回显 + 钩子）", () => {
  it("auto（系统亮，jsdom 无 matchMedia）→ data-theme=light、modu-theme=auto、下拉回显 auto", () => {
    const hook = vi.fn();
    setupThemeEngine(hook);
    applyThemePref("auto");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("modu-theme")).toBe("auto");
    expect((document.getElementById("set-theme") as HTMLSelectElement).value).toBe("auto");
    expect(hook).toHaveBeenCalledWith("light"); // 钩子收解析值（Mermaid 重画用）
  });

  it("dark → data-theme=dark、◐ 钮 title 回显当前档", () => {
    setupThemeEngine(vi.fn());
    applyThemePref("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.getElementById("btn-theme")?.title).toContain("深色");
  });
});

describe("配色（D-01：5 套主题，与 data-theme 正交）", () => {
  it("readPalettePref：无记录/坏值回退 dianlan；五套合法值原样读回", () => {
    expect(readPalettePref()).toBe("dianlan");
    localStorage.setItem("modu-palette", "乱码");
    expect(readPalettePref()).toBe("dianlan");
    for (const pref of ["dianlan", "xuanzhi", "shimo", "zidai", "qingmo"] as const) {
      localStorage.setItem("modu-palette", pref);
      expect(readPalettePref()).toBe(pref);
    }
  });

  it("applyPalettePref：data-palette=键 + modu-palette 持久化 + 下拉回显 + 钩子收解析亮暗", () => {
    const hook = vi.fn();
    setupThemeEngine(hook);
    applyThemePref("dark");
    applyPalettePref("zidai");
    expect(document.documentElement.dataset.palette).toBe("zidai");
    expect(localStorage.getItem("modu-palette")).toBe("zidai");
    expect((document.getElementById("set-palette") as HTMLSelectElement).value).toBe("zidai");
    expect(hook).toHaveBeenLastCalledWith("dark"); // Mermaid 重画收解析值
  });

  it("两维度互不干涉：改亮暗不动 data-palette，改配色不动 data-theme", () => {
    applyPalettePref("qingmo");
    applyThemePref("dark");
    expect(document.documentElement.dataset.palette).toBe("qingmo");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyPalettePref("shimo");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyThemePref("light");
    expect(document.documentElement.dataset.palette).toBe("shimo");
  });

  it("◐ 钮 title 同时回显亮暗档与配色（元素缺席时不抛错）", () => {
    applyPalettePref("xuanzhi");
    applyThemePref("light");
    const title = document.getElementById("btn-theme")?.title ?? "";
    expect(title).toContain("浅色");
    expect(title).toContain("宣纸");
  });
});

describe("watchSystemTheme（系统变化即时跟随，仅自动档）", () => {
  /** 桩 matchMedia：matches 用 getter 读实时值（后续 matchMedia() 调用同源） */
  function stubMatchMedia(): (nowDark: boolean) => void {
    let nowDark = false;
    const listeners: Array<(ev: { matches: boolean }) => void> = [];
    const mq = {
      get matches(): boolean {
        return nowDark;
      },
      addEventListener: (_type: string, cb: (ev: { matches: boolean }) => void) => {
        listeners.push(cb);
      },
    };
    vi.stubGlobal("matchMedia", vi.fn(() => mq));
    watchSystemTheme();
    return (dark: boolean): void => {
      nowDark = dark;
      for (const cb of listeners) {
        cb({ matches: dark });
      }
    };
  }

  it("自动档：系统转暗 → data-theme 即时切 dark；转亮 → 回 light", () => {
    const fire = stubMatchMedia();
    applyThemePref("auto");
    expect(document.documentElement.dataset.theme).toBe("light"); // 初始系统亮
    fire(true); // 系统转暗
    expect(document.documentElement.dataset.theme).toBe("dark");
    fire(false); // 又转亮
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("亮/暗档是显式选择：系统变化不覆盖", () => {
    const fire = stubMatchMedia();
    applyThemePref("dark");
    fire(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
