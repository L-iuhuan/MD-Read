/**
 * 查找条（M2 波1，F6）核心断言：mark 的 wrap/unwrap 不改一字——
 * 关闭与重搜后 #doc 的 textContent 必须与开启前逐字节一致（M1 复制保真红线），
 * 语料含中文与金额串 $1,000。另覆盖：大小写不敏感、跳过 .katex/script、
 * Enter/Shift+Enter 环绕、Ctrl+F/Esc、输入法组词中的 Enter 不翻页。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { setupFindbar } from "../src/ui/findbar";

const CORPUS = [
  "<p id='p1'>金额对拍：$1,000 与 $2,000 共计 $3,000。</p>",
  "<p id='p2'>中文查找段落甲，词汇 repeated 再次 repeated 出现。</p>",
  "<p id='p3'>公式外 token_outside 可见。</p>",
  "<span class='katex'><span>token_inside 公式内</span></span>",
  "<script>var token_inside = 1;</script>",
].join("");

function getDoc(): HTMLElement {
  return document.getElementById("doc") as HTMLElement;
}
function getInput(): HTMLInputElement {
  return document.getElementById("find-input") as HTMLInputElement;
}
function getCount(): string {
  return (document.getElementById("find-count") as HTMLElement).textContent ?? "";
}
function marksInDoc(): HTMLElement[] {
  return Array.from(getDoc().querySelectorAll<HTMLElement>("mark.find-hit"));
}
function currentMark(): HTMLElement | null {
  return getDoc().querySelector<HTMLElement>("mark.find-current");
}
function typeIn(value: string): void {
  const input = getInput();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
function pressKey(target: EventTarget, key: string, opts?: { shift?: boolean; ctrl?: boolean; composing?: boolean }): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      shiftKey: opts?.shift ?? false,
      ctrlKey: opts?.ctrl ?? false,
      isComposing: opts?.composing ?? false,
    })
  );
}

beforeEach(() => {
  document.body.innerHTML =
    '<div id="findbar" hidden><input id="find-input" /><span id="find-count">0/0</span>' +
    '<button id="find-prev">↑</button><button id="find-next">↓</button>' +
    '<button id="find-close">✕</button></div>' +
    '<article id="doc"></article>';
  getDoc().innerHTML = CORPUS;
  Element.prototype.scrollIntoView = (): void => {}; // jsdom 未实现，替换为空操作
});

describe("wrap/unwrap 文本一致性（复制保真红线）", () => {
  it("查找→翻页→关闭：textContent 逐字节还原，金额串原样", () => {
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("000"); // 三个金额 1,000/2,000/3,000 各含 000
    expect(marksInDoc().length).toBe(3);
    expect(getCount()).toBe("1/3");
    pressKey(getInput(), "Enter");
    pressKey(getInput(), "Enter");
    findbar.close();
    expect(marksInDoc().length).toBe(0);
    expect(getDoc().textContent).toBe(before);
    expect(getDoc().textContent).toContain("$1,000 与 $2,000 共计 $3,000。");
  });

  it("中文多命中 + 重搜清旧 mark 后仍逐字节还原", () => {
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("repeated");
    expect(marksInDoc().length).toBe(2);
    typeIn("段落");
    expect(marksInDoc().length).toBe(1); // 旧 mark 已清，只剩新查询
    findbar.close();
    expect(getDoc().textContent).toBe(before);
  });

  it("同一文本节点内多次命中：关闭后仍逐字节还原", () => {
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("0"); // 同一文本节点内多次命中：三个金额共 9 个 0
    expect(marksInDoc().length).toBe(9);
    findbar.close();
    expect(getDoc().textContent).toBe(before);
  });
});

describe("查找范围与匹配规则", () => {
  it("大小写不敏感", () => {
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("TOKEN_OUTSIDE");
    expect(marksInDoc().length).toBe(1);
    expect(currentMark()?.textContent).toBe("token_outside");
  });

  it("跳过 .katex 内部与 script/style", () => {
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("token_inside");
    expect(marksInDoc().length).toBe(0);
    typeIn("公式内");
    expect(marksInDoc().length).toBe(0);
    typeIn("token_outside");
    expect(marksInDoc().length).toBe(1);
  });

  it("空查询不计命中", () => {
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("");
    expect(marksInDoc().length).toBe(0);
    expect(getCount()).toBe("0/0");
  });
});

describe("键位与计数", () => {
  it("Enter 下一个、环绕；Shift+Enter 上一个", () => {
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("repeated");
    expect(getCount()).toBe("1/2");
    expect(currentMark()?.textContent).toBe("repeated");
    pressKey(getInput(), "Enter");
    expect(getCount()).toBe("2/2");
    pressKey(getInput(), "Enter"); // 环绕回第一个
    expect(getCount()).toBe("1/2");
    pressKey(getInput(), "Enter", { shift: true }); // 从第一个向上环绕到最后
    expect(getCount()).toBe("2/2");
  });

  it("Ctrl+F 开、Esc 关且清 mark", () => {
    const findbar = setupFindbar(() => getDoc());
    pressKey(document, "f", { ctrl: true });
    expect(findbar.isOpen()).toBe(true);
    expect((document.getElementById("findbar") as HTMLElement).hidden).toBe(false);
    typeIn("金额");
    expect(marksInDoc().length).toBe(1);
    pressKey(document, "Escape");
    expect(findbar.isOpen()).toBe(false);
    expect(marksInDoc().length).toBe(0);
  });

  it("输入法组词中的 Enter 不翻页", () => {
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("repeated");
    pressKey(getInput(), "Enter", { composing: true });
    expect(getCount()).toBe("1/2");
  });

  it("↑/↓ 按钮与关闭按钮", () => {
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("repeated");
    (document.getElementById("find-next") as HTMLElement).click();
    expect(getCount()).toBe("2/2");
    (document.getElementById("find-prev") as HTMLElement).click();
    expect(getCount()).toBe("1/2");
    (document.getElementById("find-close") as HTMLElement).click();
    expect(findbar.isOpen()).toBe(false);
    expect(marksInDoc().length).toBe(0);
  });
});

/**
 * P0-4 回归（WSL 评审实测）：页面可见文字含「中文English混排」时搜 `中文English` 返回 0/0。
 *
 * 根因：旧实现逐个文本节点 indexOf，而 pangu 会在 CJK↔拉丁边界插入**空** `.cjk-gap`
 * span 把文本节点切开；tok-break 的长 token 包裹、`strong`/`em` 内联元素同样会切开。
 * 于是任何跨节点的可见连续文字都搜不到。
 *
 * 修复口径：按「最近的块级祖先」把块内文本节点拼成一串并建立
 * 「字符偏移 → 文本节点」映射，在拼接串上匹配后再用 Range 跨节点包 mark；
 * 空 span 不参与映射但也不阻断匹配。关闭/重搜后 textContent 仍须逐字节还原。
 */
describe("P0-4 跨节点匹配（pangu 空 span / tok-break / strong-em）", () => {
  const SPLIT_CORPUS = [
    // pangu：中西文边界被空 .cjk-gap span 切开（实测原始复现形态）
    "<p id='s1'>中文<span class='cjk-gap'></span>English<span class='cjk-gap'></span>混排</p>",
    // tok-break：长 token 被 span 包裹
    "<p id='s2'>前缀 abcdefghij<span class='tokbreak'></span>klmnopqrst 后缀</p>",
    // 内联元素切分
    "<p id='s3'>甲<strong>乙</strong>丙<em>丁</em>戊</p>",
    // 金额串跨空 span（`$` 必须纯文本，不能被当成公式）
    "<p id='s4'>应付<span class='cjk-gap'></span>$1,000 与 $2,000。</p>",
    // 块边界：两个相邻段落之间**不允许**跨块命中
    "<p id='s5'>前段结束end</p><p id='s6'>start后段开始</p>",
  ].join("");

  function mountSplit(): void {
    getDoc().innerHTML = SPLIT_CORPUS;
  }

  it("跨 pangu 空 span：搜「中文English」命中（旧实现 0/0）", () => {
    mountSplit();
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("中文English");
    expect(marksInDoc().length).toBe(1);
    expect(marksInDoc()[0].textContent).toBe("中文English");
    findbar.close();
    expect(getDoc().textContent).toBe(before); // 复制保真红线
  });

  it("跨 pangu 空 span：搜「English混排」命中", () => {
    mountSplit();
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("English混排");
    expect(marksInDoc().length).toBe(1);
    findbar.close();
    expect(getDoc().textContent).toBe(before);
  });

  it("跨 tok-break span：搜整个长 token 命中", () => {
    mountSplit();
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("abcdefghijklmnopqrst");
    expect(marksInDoc().length).toBe(1);
    expect(marksInDoc()[0].textContent).toBe("abcdefghijklmnopqrst");
    findbar.close();
    expect(getDoc().textContent).toBe(before);
  });

  it("跨 strong/em：搜「甲乙丙丁戊」命中", () => {
    mountSplit();
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("甲乙丙丁戊");
    expect(marksInDoc().length).toBe(1);
    findbar.close();
    expect(getDoc().textContent).toBe(before);
  });

  it("金额串跨空 span：搜「$1,000」命中且关闭后原样", () => {
    mountSplit();
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("$1,000");
    expect(marksInDoc().length).toBe(1);
    expect(marksInDoc()[0].textContent).toBe("$1,000");
    findbar.close();
    expect(getDoc().textContent).toBe(before);
    expect(getDoc().textContent).toContain("$1,000 与 $2,000。");
  });

  it("不跨块：两个相邻段落之间的字串不得命中", () => {
    mountSplit();
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("endstart");
    expect(marksInDoc().length).toBe(0);
  });

  it("跨节点命中多次 + 重搜清旧 mark 后 textContent 仍逐字节还原", () => {
    mountSplit();
    const before = getDoc().textContent;
    const findbar = setupFindbar(() => getDoc());
    findbar.open();
    typeIn("中文English"); // 1 处跨节点
    expect(marksInDoc().length).toBe(1);
    typeIn("English"); // 重搜：清旧 mark 后同一文本节点内命中
    expect(marksInDoc().length).toBe(1);
    findbar.close();
    expect(getDoc().textContent).toBe(before);
  });
});
