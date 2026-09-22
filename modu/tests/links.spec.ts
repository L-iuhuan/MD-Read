/**
 * 外链劫持拦截（P5 批1，P0 #1）断言：
 * - classifyHref 三分类（外链/内锚/相对），scheme 大小写不敏感；
 * - setupExternalLinks 捕获委托：外链 preventDefault 且经 opener 打开，
 *   内锚与相对链接放行默认行为；点击落在链接内嵌元素时向上命中；
 * - 幂等（重复注册不叠加监听器）；打开失败走 catch 不外抛（禁空 catch）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

import { classifyHref, setupExternalLinks } from "../src/app/links";

function clickOn(target: Element): MouseEvent {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  mocks.openUrl.mockReset().mockResolvedValue(undefined);
  document.body.innerHTML = "";
});

describe("classifyHref：href 三分类判定", () => {
  it("https 与 http 开头 → 外链；scheme 大小写不敏感", () => {
    expect(classifyHref("https://example.com/a?b=1")).toBe("external");
    expect(classifyHref("http://example.com")).toBe("external");
    expect(classifyHref("HTTPS://EXAMPLE.COM/X")).toBe("external");
    expect(classifyHref("Http://example.com")).toBe("external");
  });

  it("# 开头 → 内锚", () => {
    expect(classifyHref("#section-1")).toBe("anchor");
    expect(classifyHref("#")).toBe("anchor");
  });

  it("其余（含相对路径与非 http 协议）→ 相对（放行默认行为）", () => {
    expect(classifyHref("./other.md")).toBe("relative");
    expect(classifyHref("img/pic.png")).toBe("relative");
    expect(classifyHref("../up/one.md")).toBe("relative");
    expect(classifyHref("mailto:user@host")).toBe("relative");
  });
});

describe("setupExternalLinks：容器级捕获拦截", () => {
  function mount(html: string): HTMLElement {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    setupExternalLinks(container);
    return container;
  }

  it("外链：preventDefault 并交 opener 打开；点击落在内嵌元素也命中", () => {
    const container = mount('<p>看<a href="https://tauri.app/zh/">这个<em>链接</em></a></p>');
    const event = clickOn(container.querySelector("em") as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
    expect(mocks.openUrl).toHaveBeenCalledWith("https://tauri.app/zh/");
  });

  it("内锚与相对链接：放行默认行为，不经 opener", () => {
    const container = mount(
      '<a href="#section-1">内锚</a> | <a href="./sibling.md">相对</a>'
    );
    const [anchor, rel] = Array.from(container.querySelectorAll("a"));
    expect(clickOn(anchor).defaultPrevented).toBe(false);
    expect(clickOn(rel).defaultPrevented).toBe(false);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("幂等：重复调用不重复注册（一次点击只开一次）", () => {
    const container = mount('<a href="https://example.com/x">外链</a>');
    setupExternalLinks(container); // 第二次注册应被 data 标记挡下
    clickOn(container.querySelector("a") as Element);
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
  });

  it("打开失败：catch 具体错误并留中文控制台证据，不外抛", () => {
    mocks.openUrl.mockRejectedValue(new Error("no app associated"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const container = mount('<a href="https://example.com/fail">失败链</a>');
    const event = clickOn(container.querySelector("a") as Element);
    expect(event.defaultPrevented).toBe(true); // 拦截照旧：不让 WebView 导航走
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(mocks.openUrl).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain("无法在系统浏览器打开链接");
        errorSpy.mockRestore();
        resolve();
      }, 0);
    });
  });
});
