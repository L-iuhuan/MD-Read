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

import {
  classifyHref,
  resolveRelativeHref,
  setupExternalLinks,
  type RelativeLinkHandlers,
} from "../src/app/links";

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

  it("其余（相对路径）→ 相对（放行默认行为）；单字母盘符不算 scheme", () => {
    expect(classifyHref("./other.md")).toBe("relative");
    expect(classifyHref("img/pic.png")).toBe("relative");
    expect(classifyHref("../up/one.md")).toBe("relative");
    expect(classifyHref("c:\\docs\\a.md")).toBe("relative"); // 盘符形态，不是协议
  });

  it("F4：mailto/tel → 交系统默认应用；其余协议 → 不支持", () => {
    expect(classifyHref("mailto:user@host")).toBe("mailto");
    expect(classifyHref("MAILTO:a@b.c")).toBe("mailto"); // scheme 大小写不敏感
    expect(classifyHref("tel:+8613800000000")).toBe("tel");
    expect(classifyHref("TEL:+1234")).toBe("tel");
    expect(classifyHref("ftp://files.example.com/x.zip")).toBe("unsupported");
    expect(classifyHref("javascript:alert(1)")).toBe("unsupported"); // 陌生 scheme 一律不支持
  });
});

describe("setupExternalLinks：容器级捕获拦截", () => {
  function mount(html: string, handlers?: RelativeLinkHandlers): HTMLElement {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    setupExternalLinks(container, handlers);
    return container;
  }

  it("外链：preventDefault 并交 opener 打开；点击落在内嵌元素也命中", () => {
    const container = mount('<p>看<a href="https://tauri.app/zh/">这个<em>链接</em></a></p>');
    const event = clickOn(container.querySelector("em") as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
    expect(mocks.openUrl).toHaveBeenCalledWith("https://tauri.app/zh/");
  });

  it("内锚与空 href：放行默认行为，不经 opener（C3 语义：现状不动）", () => {
    const container = mount('<a href="#section-1">内锚</a> | <a href="">空</a>');
    const [anchor, empty] = Array.from(container.querySelectorAll("a"));
    expect(clickOn(anchor).defaultPrevented).toBe(false);
    expect(clickOn(empty).defaultPrevented).toBe(false);
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

/* C3（2026-09-29）：相对链接不再放行默认导航（会把整窗带到 404）——
   .md 系走「解析为绝对路径 + 注入的 openMd（main.ts 接既有 openPath 链）」，
   其余闪示「该链接指向应用外文件，未打开」。 */
describe("C3：相对链接接管", () => {
  function mount(html: string, handlers: RelativeLinkHandlers): HTMLElement {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    setupExternalLinks(container, handlers);
    return container;
  }

  it("相对 .md 链接：preventDefault，解析为基于当前文档目录的绝对路径走 openMd", () => {
    const openMd = vi.fn();
    const container = mount(
      '<a href="./sibling.md">同级</a><a href="../up/note.MDX">上一级</a><a href="sub/deep.markdown">下级</a>',
      { docPath: () => "C:\\docs\\sub\\cur.md", openMd },
    );
    const [sib, up, deep] = Array.from(container.querySelectorAll("a"));
    expect(clickOn(sib).defaultPrevented).toBe(true);
    expect(openMd).toHaveBeenCalledWith("C:\\docs\\sub\\sibling.md");
    expect(clickOn(up).defaultPrevented).toBe(true);
    expect(openMd).toHaveBeenCalledWith("C:\\docs\\up\\note.MDX");
    expect(clickOn(deep).defaultPrevented).toBe(true);
    expect(openMd).toHaveBeenCalledWith("C:\\docs\\sub\\sub\\deep.markdown");
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("非 md 相对链接：preventDefault + 状态栏闪示，绝不导航", () => {
    const notify = vi.fn();
    const container = mount('<a href="assets/data.xlsx">表</a>', {
      docPath: () => "C:\\docs\\a.md",
      openMd: vi.fn(),
      notify,
    });
    const [xlsx] = Array.from(container.querySelectorAll("a"));
    expect(clickOn(xlsx).defaultPrevented).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("该链接指向应用外文件，未打开");
  });

  it("F4：mailto/tel 点击 → preventDefault 并交 opener（系统默认邮件/电话应用）", () => {
    const notify = vi.fn();
    const container = mount(
      '<a href="mailto:hi@example.com">信</a><a href="tel:+86138">话</a>',
      { notify },
    );
    const [mail, tel] = Array.from(container.querySelectorAll("a"));
    expect(clickOn(mail).defaultPrevented).toBe(true);
    expect(clickOn(tel).defaultPrevented).toBe(true);
    expect(mocks.openUrl).toHaveBeenCalledTimes(2);
    expect(mocks.openUrl).toHaveBeenCalledWith("mailto:hi@example.com");
    expect(mocks.openUrl).toHaveBeenCalledWith("tel:+86138");
    expect(notify).not.toHaveBeenCalled();
  });

  it("F4：其余协议（ftp: 等）→ preventDefault + 状态栏提示不支持，不经 opener", () => {
    const notify = vi.fn();
    const container = mount('<a href="ftp://files.example.com/x.zip">ftp</a>', { notify });
    const event = clickOn(container.querySelector("a") as Element);
    expect(event.defaultPrevented).toBe(true);
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("暂不支持 ftp: 链接");
  });

  it("handlers 每次接线刷新（重挂容器后基准路径随新文档）", () => {
    const openMd = vi.fn();
    const container = mount('<a href="./x.md">相对</a>', {
      docPath: () => "C:\\old\\a.md",
      openMd,
    });
    setupExternalLinks(container, { docPath: () => "D:\\new\\b.md", openMd });
    clickOn(container.querySelector("a") as Element);
    expect(openMd).toHaveBeenCalledWith("D:\\new\\x.md"); // 用的是最新一次注入的基准
    expect(openMd).toHaveBeenCalledTimes(1); // 监听器没有叠加
  });
});

describe("C3：resolveRelativeHref 纯函数（词法解析，归一交给 Rust 链）", () => {
  it("./ 与子目录拼接；. 与空段忽略", () => {
    expect(resolveRelativeHref("./x.md", "C:\\docs\\a.md")).toBe("C:\\docs\\x.md");
    expect(resolveRelativeHref("b/c.md", "C:\\docs\\a.md")).toBe("C:\\docs\\b\\c.md");
    expect(resolveRelativeHref(".\\x.md", "C:\\docs\\a.md")).toBe("C:\\docs\\x.md");
  });

  it(".. 逐级上溯，夹到盘符根不越界", () => {
    expect(resolveRelativeHref("../up.md", "C:\\docs\\sub\\a.md")).toBe("C:\\docs\\up.md");
    expect(resolveRelativeHref("../../up.md", "C:\\docs\\sub\\a.md")).toBe("C:\\up.md");
    expect(resolveRelativeHref("../../../../esc.md", "C:\\docs\\sub\\a.md")).toBe("C:\\esc.md");
  });

  it("百分号解码（markdown-it 转义空格）；裸 % 不抛按原样", () => {
    expect(resolveRelativeHref("./my%20file.md", "C:\\docs\\a.md")).toBe("C:\\docs\\my file.md");
    expect(resolveRelativeHref("./100%.md", "C:\\docs\\a.md")).toBe("C:\\docs\\100%.md");
  });

  it("canonical 前缀（\\\\?\\）与正斜杠分隔符原样兼容", () => {
    expect(resolveRelativeHref("./x.md", "\\\\?\\c:\\docs\\a.md")).toBe("\\\\?\\c:\\docs\\x.md");
    expect(resolveRelativeHref("b/x.md", "C:/docs/a.md")).toBe("C:\\docs\\b\\x.md");
  });
});
