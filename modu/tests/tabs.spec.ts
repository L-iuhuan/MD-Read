/**
 * 标签管理状态机（M2 波1，F5）：mock renderDocument，断言懒挂载语义——
 * 开标签/激活/切换/关闭/空态、scroll 保存与恢复、dirty 确认分流、
 * 标签栏 DOM（活动类、圆点、✕）。
 * P5 批3 增两组：渲染缓存（切回免重渲/失效条件）与 loading 时序
 * （先绘后渲：begin → render → mount → end）。
 * 注意：未命中缓存的激活走双 rAF 延迟渲染——所有触发渲染的操作后须 await flushed()。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createTabManager,
  type MountContext,
  type Tab,
  type TabManager,
  type TabManagerDeps,
} from "../src/app/tabs";
import type { RenderResult } from "../src/render/pipeline";
import { flushed, fragOf } from "./raf";

interface Harness {
  manager: TabManager;
  state: { scroll: number };
  render: ReturnType<typeof vi.fn>;
  mountDoc: ReturnType<typeof vi.fn>;
  onEmpty: ReturnType<typeof vi.fn>;
  harvestDoc: ReturnType<typeof vi.fn>;
  beginLoading: ReturnType<typeof vi.fn>;
  endLoading: ReturnType<typeof vi.fn>;
}

function setup(confirmResult = true): Harness {
  document.body.innerHTML =
    '<div id="tabbar" hidden><div id="tab-list"></div><button id="btn-newtab">+</button></div>' +
    '<main id="content"><article id="doc" hidden></article></main>';
  const state = { scroll: 0 };
  const content = document.getElementById("content") as HTMLElement;
  const render = vi.fn((src: string): RenderResult => ({
    html: `<p>${src}</p>`,
    outline: [{ level: 1, text: `§${src}`, id: "anchor-1", line: 1 }],
    fragment: fragOf(`<p>${src}</p>`),
  }));
  const mountDoc = vi.fn((ctx: MountContext) => {
    const doc = document.getElementById("doc") as HTMLElement;
    ctx.tab.cachedFragment = null; // 与 main.ts mountRendered 同款消费语义
    doc.replaceChildren();
    doc.appendChild(document.adoptNode(ctx.fragment));
    doc.hidden = false;
  });
  const harvestDoc = vi.fn((): DocumentFragment | null => {
    const doc = document.getElementById("doc");
    if (doc === null || doc.hidden || doc.childNodes.length === 0) {
      return null;
    }
    const frag = document.createDocumentFragment();
    frag.replaceChildren(...Array.from(doc.childNodes)); // 与 main.ts 同款零拷贝回收
    return frag;
  });
  const beginLoading = vi.fn(() => content.classList.add("content-loading"));
  const endLoading = vi.fn(() => content.classList.remove("content-loading"));
  const onEmpty = vi.fn();
  const deps: TabManagerDeps = {
    render,
    mountDoc,
    harvestDoc,
    beginLoading,
    endLoading,
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
  return { manager, state, render, mountDoc, onEmpty, harvestDoc, beginLoading, endLoading };
}

/** 触发渲染的操作统一包一层冲刷（未命中缓存即延迟渲染） */
async function open(h: Harness, path: string, text: string, activate = true): Promise<void> {
  h.manager.openTab(path, { text, encoding: "UTF-8" }, activate);
  await flushed();
}
async function activate(h: Harness, path: string): Promise<void> {
  h.manager.activateTab(path);
  await flushed();
}
async function close(h: Harness, path: string): Promise<void> {
  h.manager.closeTab(path);
  await flushed();
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
function loadingOn(): boolean {
  return (document.getElementById("content") as HTMLElement).classList.contains("content-loading");
}

describe("openTab / 激活", () => {
  it("新标签：渲染挂载、tabbar 可见、活动项带 active 与标题", async () => {
    const h = setup();
    await open(h, "D:\\docs\\a.md", "AAA");
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

  it("同路径重开：不新增标签，刷新内容并回顶部", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    h.state.scroll = 777;
    h.manager.openTab("a.md", { text: "BBB", encoding: "GB18030" });
    await flushed();
    expect(h.manager.count()).toBe(1);
    expect(h.render).toHaveBeenLastCalledWith("BBB");
    expect(docHtml()).toBe("<p>BBB</p>");
    expect(h.state.scroll).toBe(0);
    expect(h.manager.activeTab()?.encoding).toBe("GB18030");
  });

  it("懒挂载：开第二个标签后正文只剩活动者，切回即重渲", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    expect(h.manager.count()).toBe(2);
    expect(h.manager.activeTab()?.path).toBe("b.md");
    expect(docHtml()).toBe("<p>BBB</p>"); // A 的 DOM 已让位（P5 批3 起回收到缓存）
    await activate(h, "a.md");
    expect(docHtml()).toBe("<p>AAA</p>");
    expect(activeEl()?.dataset.path).toBe("a.md");
  });

  it("点标签条切换激活（DOM 事件路径）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    (tabEls()[0] as HTMLElement).click();
    await flushed();
    expect(h.manager.activeTab()?.path).toBe("a.md");
    expect(docHtml()).toBe("<p>AAA</p>");
  });
});

describe("openTab activate 参数（P5 批2：多文件只渲染最后一个）", () => {
  it("activate=false：只上栏不挂载——不渲染、活动标签不变、正文不动", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB", false);
    expect(h.manager.count()).toBe(2);
    expect(h.manager.activeTab()?.path).toBe("a.md"); // 活动标签仍是 a
    expect(h.render).not.toHaveBeenCalledWith("BBB");
    expect(docHtml()).toBe("<p>AAA</p>"); // 正文保持 a 的渲染
    expect(tabEls().length).toBe(2); // 标签条两枚都上栏
  });

  it("末项 activate=true：激活并渲染（连开场景的收尾）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB", false);
    await open(h, "c.md", "CCC");
    expect(h.manager.activeTab()?.path).toBe("c.md");
    expect(docHtml()).toBe("<p>CCC</p>");
  });

  it("刷新当前活动标签时即便 activate=false 也强制重挂（防 stale DOM）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "a.md", "NEW", false);
    expect(h.render).toHaveBeenLastCalledWith("NEW");
    expect(docHtml()).toBe("<p>NEW</p>");
  });
});

describe("scroll 保存与恢复（懒挂载下位置正确）", () => {
  it("切走保存、切回恢复", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    h.state.scroll = 123;
    await open(h, "b.md", "BBB");
    h.state.scroll = 456;
    await activate(h, "a.md");
    expect(h.state.scroll).toBe(123);
    await activate(h, "b.md");
    expect(h.state.scroll).toBe(456);
  });
});

describe("closeTab", () => {
  it("关闭活动标签：后继邻居接替激活", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    await open(h, "c.md", "CCC");
    await close(h, "b.md");
    expect(h.manager.count()).toBe(2);
    expect(h.manager.activeTab()?.path).toBe("c.md");
    expect(docHtml()).toBe("<p>CCC</p>");
  });

  it("关闭最后一个标签：前一个接替", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    await close(h, "b.md");
    expect(h.manager.activeTab()?.path).toBe("a.md");
    expect(docHtml()).toBe("<p>AAA</p>");
  });

  it("关闭非活动标签不影响当前渲染", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    await close(h, "a.md");
    expect(h.manager.activeTab()?.path).toBe("b.md");
    expect(docHtml()).toBe("<p>BBB</p>");
  });

  it("清空全部：onEmpty 回调 + tabbar 隐藏", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await close(h, "a.md");
    expect(h.manager.count()).toBe(0);
    expect(h.onEmpty).toHaveBeenCalledTimes(1);
    expect(barHidden()).toBe(true);
  });

  it("点 ✕ 关闭（DOM 事件路径，不冒泡成切换）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    const closeBtn = document.querySelector<HTMLElement>("#tab-list .tab-close");
    (closeBtn as HTMLElement).click();
    await flushed();
    expect(h.manager.count()).toBe(0);
  });
});

describe("dirty 标记（M3 启用，渲染先就绪）", () => {
  it("confirm 拒绝时保留标签，同意时关闭", async () => {
    const refused = setup(false);
    await open(refused, "a.md", "AAA");
    refused.manager.setDirty("a.md", true);
    const dot = document.querySelector<HTMLElement>("#tab-list .tab-dirty");
    expect(dot?.hidden).toBe(false); // 圆点随 dirty 显隐
    refused.manager.closeTab("a.md");
    expect(refused.manager.count()).toBe(1); // 用户取消，未关闭

    const allowed = setup(true);
    await open(allowed, "a.md", "AAA");
    allowed.manager.setDirty("a.md", true);
    allowed.manager.closeTab("a.md");
    expect(allowed.manager.count()).toBe(0);
  });

  it("干净标签关闭不走确认", async () => {
    const h = setup(false); // confirm 恒 false
    await open(h, "a.md", "AAA");
    await close(h, "a.md");
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

describe("渲染缓存（P5 批3：切走回收、切回免重渲）", () => {
  it("切走回收正文、切回命中：零渲染、正文与大纲原样回归", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    expect(h.harvestDoc).toHaveBeenCalled(); // 离开 a 时零拷贝回收
    const calls = h.render.mock.calls.length;
    await activate(h, "a.md");
    expect(h.render.mock.calls.length).toBe(calls); // 命中：跳过 renderDocument
    expect(docHtml()).toBe("<p>AAA</p>");
    expect(h.mountDoc).toHaveBeenLastCalledWith(
      expect.objectContaining({ outline: [expect.objectContaining({ text: "§AAA" })] })
    );
  });

  it("缓存可重复命中（a→b→a→b 交替全程零新增渲染）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    const calls = h.render.mock.calls.length;
    await activate(h, "a.md");
    await activate(h, "b.md");
    await activate(h, "a.md");
    expect(h.render.mock.calls.length).toBe(calls);
    expect(docHtml()).toBe("<p>AAA</p>");
  });

  it("失效条件①同路径重开：缓存作废，重渲新文（防挂旧文）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    await open(h, "a.md", "NEW"); // 刷新 a
    expect(h.render).toHaveBeenLastCalledWith("NEW");
    expect(docHtml()).toBe("<p>NEW</p>");
  });

  it("失效条件②harvest 返回 null（编辑态/空正文）：不缓存，切回重渲", async () => {
    const h = setup();
    h.harvestDoc.mockReturnValue(null);
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    const calls = h.render.mock.calls.length;
    await activate(h, "a.md");
    expect(h.render.mock.calls.length).toBe(calls + 1); // 未缓存：重新渲染
    expect(docHtml()).toBe("<p>AAA</p>");
  });

  it("挂载即消费：命中挂载后 tab.cachedFragment 清空，再切走回收新 DOM", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    const a = h.manager.activeTab() as Tab;
    await open(h, "b.md", "BBB");
    expect(a.cachedFragment).not.toBeNull(); // 离开后已回收
    await activate(h, "a.md");
    expect(a.cachedFragment).toBeNull(); // 上屏即消费
  });
});

describe("loading 时序（P5 批3：先绘后渲）", () => {
  it("顺序 begin → render → mount → end；渲染时指示类已落 #content，完毕即清", async () => {
    const h = setup();
    h.render.mockImplementation((src: string): RenderResult => {
      // 渲染发生的那一刻，loading 类必须已在 DOM 上（先落 DOM 再跑重活）
      expect(loadingOn()).toBe(true);
      return {
        html: `<p>${src}</p>`,
        outline: [{ level: 1, text: `§${src}`, id: "anchor-1", line: 1 }],
        fragment: fragOf(`<p>${src}</p>`),
      };
    });
    await open(h, "a.md", "AAA");
    expect(h.beginLoading.mock.invocationCallOrder[0]).toBeLessThan(
      h.render.mock.invocationCallOrder[0]
    );
    expect(h.render.mock.invocationCallOrder[0]).toBeLessThan(
      h.mountDoc.mock.invocationCallOrder[0]
    );
    expect(h.mountDoc.mock.invocationCallOrder[0]).toBeLessThan(
      h.endLoading.mock.invocationCallOrder[0]
    );
    expect(loadingOn()).toBe(false);
  });

  it("缓存命中不点亮 loading（同步直挂无重活）", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    await open(h, "b.md", "BBB");
    h.beginLoading.mockClear();
    h.endLoading.mockClear();
    await activate(h, "a.md");
    expect(h.beginLoading).not.toHaveBeenCalled();
    expect(h.endLoading).not.toHaveBeenCalled();
    expect(docHtml()).toBe("<p>AAA</p>");
  });

  it("快速连开刷新：过期票不渲染不挂载，最新者胜，loading 熄灭", async () => {
    const h = setup();
    await open(h, "a.md", "AAA");
    h.manager.openTab("a.md", { text: "V2", encoding: "UTF-8" }); // 延迟渲染 V2 排队
    h.manager.openTab("a.md", { text: "V3", encoding: "UTF-8" }); // V3 抢过票据
    await flushed();
    await flushed();
    expect(h.render).toHaveBeenLastCalledWith("V3");
    expect(h.render).not.toHaveBeenCalledWith("V2"); // 过期票在渲染前让位
    expect(docHtml()).toBe("<p>V3</p>");
    expect(loadingOn()).toBe(false); // 最后一个在途者负责熄灯
  });
});
