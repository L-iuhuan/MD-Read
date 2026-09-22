/**
 * 文档内查找（M2 波1，F6）：Ctrl+F 开、Esc 关、Enter/Shift+Enter 下一个/上一个，显示 n/N。
 * TreeWalker 遍历文本节点做大小写不敏感匹配，命中处包 <mark class="find-hit">，
 * 当前项加 find-current；跳过 .katex 内部与 script/style。
 *
 * 复制保真是 M1 验收红线：mark 只包裹既有字符、不增删一字——
 * 关闭/重搜 unwrap 后 #doc 的 textContent 必须与开启前逐字节一致
 * （tests/findbar.spec.ts 用中文+金额 $1,000 语料对拍）。
 */
export interface Findbar {
  open(): void;
  close(): void;
  isOpen(): boolean;
}

/**
 * Esc 统一关浮层（P5 批2）：依序 findbar → 设置面板 → 最近菜单，一次只关
 * 最上层一个（都开着也只关一个）；返回是否关掉了东西。
 * ⚠ main.ts 的全局 Esc 监听须先于 setupFindbar 注册，保证统一仲裁抢在
 * findbar 自有的 Esc 之前定夺（否则一次 Esc 会连关两层）。
 */
export function closeTopmostOverlay(findbar: Findbar | null): boolean {
  if (findbar !== null && findbar.isOpen()) {
    findbar.close();
    return true;
  }
  const panel = document.getElementById("settings-panel");
  if (panel !== null && !panel.hidden) {
    panel.hidden = true;
    return true;
  }
  const menu = document.getElementById("recent-menu");
  if (menu !== null && !menu.hidden) {
    menu.hidden = true;
    return true;
  }
  return false;
}

interface TextHit {
  node: Text;
  start: number;
  end: number;
}

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`界面元素缺失：#${id}`);
  }
  return el as T;
}

/** 清掉 root 内全部查找 mark：还原纯文本并合并相邻节点，字符序列不变 */
export function clearFindMarks(root: Element): void {
  for (const mark of Array.from(root.querySelectorAll("mark.find-hit"))) {
    const parent = mark.parentNode;
    if (parent !== null) {
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
      parent.normalize();
    }
  }
}

/** 收集全部命中（文档序）。空查询直接返回；公式/脚本/样式不参与 */
function collectHits(root: Element, needle: string): TextHit[] {
  const hits: TextHit[] = [];
  const key = needle.toLowerCase();
  if (key === "") {
    return hits;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (parent !== null && parent.closest(".katex, .katex-display, script, style") !== null) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    const lower = text.data.toLowerCase();
    for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + key.length)) {
      hits.push({ node: text, start: at, end: at + key.length });
    }
  }
  return hits;
}

/** 倒序包裹：先拆后文的文本节点不影响前文偏移；返回文档序的 mark 数组 */
function wrapHits(hits: TextHit[]): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    const range = document.createRange();
    range.setStart(hit.node, hit.start);
    range.setEnd(hit.node, hit.end);
    const mark = document.createElement("mark");
    mark.className = "find-hit";
    range.surroundContents(mark); // 边界都在同一文本节点内，不会跨元素
    marks.unshift(mark);
  }
  return marks;
}

/** 全局键位：Ctrl+F 开查找条，Esc 关（开着的条件下） */
function bindGlobalKeys(bar: HTMLElement, open: () => void, close: () => void): void {
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      open();
      return;
    }
    if (event.key === "Escape" && !bar.hidden) {
      close();
    }
  });
}

export function setupFindbar(getRoot: () => Element | null): Findbar {
  const bar = req<HTMLElement>("findbar");
  const input = req<HTMLInputElement>("find-input");
  const counter = req<HTMLElement>("find-count");
  let marks: HTMLElement[] = [];
  let index = 0;

  function setCurrent(): void {
    const current = marks[index];
    if (current === undefined) {
      return;
    }
    for (const mark of marks) {
      mark.classList.toggle("find-current", mark === current);
    }
    counter.textContent = `${index + 1}/${marks.length}`;
    current.scrollIntoView({ block: "center" });
  }

  function search(needle: string): void {
    const root = getRoot();
    if (root === null) {
      return;
    }
    clearFindMarks(root); // 重搜前先清旧 mark
    marks = wrapHits(collectHits(root, needle));
    index = 0;
    counter.textContent = `${marks.length > 0 ? 1 : 0}/${marks.length}`;
    if (marks.length > 0) {
      setCurrent();
    }
  }

  function step(dir: 1 | -1): void {
    if (marks.length === 0) {
      return;
    }
    index = (index + dir + marks.length) % marks.length; // 环绕查找
    setCurrent();
  }

  function open(): void {
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value !== "") {
      search(input.value); // 正文可能已被重渲，重开时重搜一次
    }
  }

  function close(): void {
    const root = getRoot();
    if (root !== null) {
      clearFindMarks(root); // unwrap：还原开启前的原文
    }
    bar.hidden = true;
  }

  input.addEventListener("input", () => search(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.isComposing) {
      return; // 中文输入法组词中的 Enter 不触发查找
    }
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    }
  });
  req<HTMLElement>("find-prev").addEventListener("click", () => step(-1));
  req<HTMLElement>("find-next").addEventListener("click", () => step(1));
  req<HTMLElement>("find-close").addEventListener("click", () => close());
  bindGlobalKeys(bar, open, close);

  return { open, close, isOpen: () => !bar.hidden };
}
