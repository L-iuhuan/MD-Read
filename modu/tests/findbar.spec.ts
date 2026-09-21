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
