/**
 * 标签管理状态机（M2 波1，F5）：mock renderDocument，断言懒挂载语义——
 * 开标签/激活/切换/关闭/空态、scroll 保存与恢复、dirty 确认分流、
 * 标签栏 DOM（活动类、圆点、✕）。
 */
import { describe, expect, it, vi } from "vitest";
import { createTabManager, type MountContext, type TabManagerDeps } from "../src/app/tabs";

interface Harness {
  manager: ReturnType<typeof createTabManager>;
  state: { scroll: number };
  render: ReturnType<typeof vi.fn>;
  mountDoc: ReturnType<typeof vi.fn>;
  onEmpty: ReturnType<typeof vi.fn>;
}

function setup(confirmResult = true): Harness {
  document.body.innerHTML =
    '<div id="tabbar" hidden><div id="tab-list"></div><button id="btn-newtab">+</button></div>' +
    '<main id="content"><article id="doc" hidden></article></main>';
  const state = { scroll: 0 };
  const render = vi.fn((src: string) => ({ html: `<p>${src}</p>`, outline: [] }));
  const mountDoc = vi.fn((ctx: MountContext) => {
    const doc = document.getElementById("doc") as HTMLElement;
    doc.innerHTML = ctx.html;
    doc.hidden = false;
  });
  const onEmpty = vi.fn();
  const deps: TabManagerDeps = {
    render,
    mountDoc,
    getScroll: () => state.scroll,
    setScroll: (top: number) => {
      state.scroll = top;
    },
    onEmpty,
    confirmClose: () => confirmResult,
  };
  const manager = createTabManager(
    document.getElementById("tabbar") as HTMLElement,
    deps
  );
  return { manager, state, render, mountDoc, onEmpty };
}

function docHtml(): string {
  return (document.getElementById("doc") as HTMLElement).innerHTML;
}
function tabEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#tab-list .tab"));
}
function activeEl(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#tab-list .tab.active");
}
function barHidden(): boolean {
  return (document.getElementById("tabbar") as HTMLElement).hidden;
}

describe("openTab / 激活", () => {
  it("新标签：渲染挂载、tabbar 可见、活动项带 active 与标题", () => {
    const h = setup();
    h.manager.openTab("D:\\docs\\a.md", { text: "AAA", encoding: "UTF-8" });
    expect(h.manager.count()).toBe(1);
    expect(h.manager.activeTab()?.path).toBe("D:\\docs\\a.md");
    expect(h.manager.activeTab()?.title).toBe("a.md");
    expect(h.manager.activeTab()?.encoding).toBe("UTF-8");
    expect(h.render).toHaveBeenCalledWith("AAA");
    expect(docHtml()).toBe("<p>AAA</p>");
    expect(barHidden()).toBe(false);
    expect(activeEl()?.dataset.path).toBe("D:\\docs\\a.md");
    expect(tabEls()[0]?.textContent).toContain("a.md");
  });

  it("同路径重开：不新增标签，刷新内容并回顶部", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.state.scroll = 777;
    h.manager.openTab("a.md", { text: "BBB", encoding: "GB18030" });
    expect(h.manager.count()).toBe(1);
    expect(h.render).toHaveBeenLastCalledWith("BBB");
    expect(docHtml()).toBe("<p>BBB</p>");
    expect(h.state.scroll).toBe(0);
    expect(h.manager.activeTab()?.encoding).toBe("GB18030");
  });

  it("懒挂载：开第二个标签后正文只剩活动者，切回即重渲", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" });
    expect(h.manager.count()).toBe(2);
    expect(h.manager.activeTab()?.path).toBe("b.md");
    expect(docHtml()).toBe("<p>BBB</p>"); // A 的 DOM 已让位，仅留 source
    h.manager.activateTab("a.md");
    expect(docHtml()).toBe("<p>AAA</p>");
    expect(activeEl()?.dataset.path).toBe("a.md");
  });

  it("点标签条切换激活（DOM 事件路径）", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" });
    (tabEls()[0] as HTMLElement).click();
    expect(h.manager.activeTab()?.path).toBe("a.md");
    expect(docHtml()).toBe("<p>AAA</p>");
  });
});

describe("openTab activate 参数（P5 批2：多文件只渲染最后一个）", () => {
  it("activate=false：只上栏不挂载——不渲染、活动标签不变、正文不动", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" }, false);
    expect(h.manager.count()).toBe(2);
    expect(h.manager.activeTab()?.path).toBe("a.md"); // 活动标签仍是 a
    expect(h.render).not.toHaveBeenCalledWith("BBB");
    expect(docHtml()).toBe("<p>AAA</p>"); // 正文保持 a 的渲染
    expect(tabEls().length).toBe(2); // 标签条两枚都上栏
  });

  it("末项 activate=true：激活并渲染（连开场景的收尾）", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" }, false);
    h.manager.openTab("c.md", { text: "CCC", encoding: "UTF-8" });
    expect(h.manager.activeTab()?.path).toBe("c.md");
    expect(docHtml()).toBe("<p>CCC</p>");
  });

  it("刷新当前活动标签时即便 activate=false 也强制重挂（防 stale DOM）", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("a.md", { text: "NEW", encoding: "UTF-8" }, false);
    expect(h.render).toHaveBeenLastCalledWith("NEW");
    expect(docHtml()).toBe("<p>NEW</p>");
  });
});

describe("scroll 保存与恢复（懒挂载下位置正确）", () => {
  it("切走保存、切回恢复", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.state.scroll = 123;
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" });
    h.state.scroll = 456;
    h.manager.activateTab("a.md");
    expect(h.state.scroll).toBe(123);
    h.manager.activateTab("b.md");
    expect(h.state.scroll).toBe(456);
  });
});

describe("closeTab", () => {
  it("关闭活动标签：后继邻居接替激活", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" });
    h.manager.openTab("c.md", { text: "CCC", encoding: "UTF-8" });
    h.manager.closeTab("b.md");
    expect(h.manager.count()).toBe(2);
    expect(h.manager.activeTab()?.path).toBe("c.md");
    expect(docHtml()).toBe("<p>CCC</p>");
  });

  it("关闭最后一个标签：前一个接替", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" });
    h.manager.closeTab("b.md");
    expect(h.manager.activeTab()?.path).toBe("a.md");
    expect(docHtml()).toBe("<p>AAA</p>");
  });

  it("关闭非活动标签不影响当前渲染", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.openTab("b.md", { text: "BBB", encoding: "UTF-8" });
    h.manager.closeTab("a.md");
    expect(h.manager.activeTab()?.path).toBe("b.md");
    expect(docHtml()).toBe("<p>BBB</p>");
  });

  it("清空全部：onEmpty 回调 + tabbar 隐藏", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.closeTab("a.md");
    expect(h.manager.count()).toBe(0);
    expect(h.onEmpty).toHaveBeenCalledTimes(1);
    expect(barHidden()).toBe(true);
  });

  it("点 ✕ 关闭（DOM 事件路径，不冒泡成切换）", () => {
    const h = setup();
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    const closeBtn = document.querySelector<HTMLElement>("#tab-list .tab-close");
    (closeBtn as HTMLElement).click();
    expect(h.manager.count()).toBe(0);
  });
});

describe("dirty 标记（M3 启用，渲染先就绪）", () => {
  it("confirm 拒绝时保留标签，同意时关闭", () => {
    const refused = setup(false);
    refused.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    refused.manager.setDirty("a.md", true);
    const dot = document.querySelector<HTMLElement>("#tab-list .tab-dirty");
    expect(dot?.hidden).toBe(false); // 圆点随 dirty 显隐
    refused.manager.closeTab("a.md");
    expect(refused.manager.count()).toBe(1); // 用户取消，未关闭

    const allowed = setup(true);
    allowed.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    allowed.manager.setDirty("a.md", true);
    allowed.manager.closeTab("a.md");
    expect(allowed.manager.count()).toBe(0);
  });

  it("干净标签关闭不走确认", () => {
    const h = setup(false); // confirm 恒 false
    h.manager.openTab("a.md", { text: "AAA", encoding: "UTF-8" });
    h.manager.closeTab("a.md");
    expect(h.manager.count()).toBe(0);
  });
});

describe("异常路径", () => {
  it("激活/置脏不存在的标签报中文错误", () => {
    const h = setup();
    expect(() => h.manager.activateTab("无.md")).toThrow("标签不存在");
    expect(() => h.manager.setDirty("无.md", true)).toThrow("标签不存在");
  });
});
