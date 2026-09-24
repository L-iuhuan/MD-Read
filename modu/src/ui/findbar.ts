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
 * Esc 统一关浮层（P5 批2）：依序 findbar → 设置面板 → 最近菜单 → 全部标签列表（▾）
 * → 溢出菜单（⋯），一次只关最上层一个（都开着也只关一个）；返回是否关掉了东西。
 * D-05 追加后两者：新菜单与旧浮层共用同一个仲裁，不各自绑 Esc（否则一次 Esc 关两层）。
 * ⚠ main.ts 的全局 Esc 监听须先于 setupFindbar 注册，保证统一仲裁抢在
 * findbar 自有的 Esc 之前定夺（否则一次 Esc 会连关两层）。
 */
export function closeTopmostOverlay(findbar: Findbar | null): boolean {
  if (findbar !== null && findbar.isOpen()) {
    findbar.close();
    return true;
  }
  const overlayIds = ["settings-panel", "recent-menu", "tabs-menu", "overflow-menu"];
  for (const id of overlayIds) {
    const el = document.getElementById(id);
    if (el !== null && !el.hidden) {
      el.hidden = true;
      // ▾ / ⋯ 的按钮点灯态同步复位（aria-expanded 是它的可见回显）
      const btn = id === "tabs-menu" ? "tabs-list" : id === "overflow-menu" ? "btn-overflow" : null;
      if (btn !== null) {
        document.getElementById(btn)?.setAttribute("aria-expanded", "false");
      }
      return true;
    }
  }
  return false;
}

interface TextSpan {
  node: Text;
  /** 该节点在块内拼接串中的起始偏移（含） */
  from: number;
  /** 结束偏移（不含） */
  to: number;
}

interface TextHit {
  startNode: Text;
  startOffset: number;
  endNode: Text;
  endOffset: number;
}

/** 块级标签：跨节点匹配只在同一块内进行，避免把相邻段落连读成一个串 */
const BLOCK_TAGS = new Set([
  "P", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH",
  "BLOCKQUOTE", "PRE", "DT", "DD", "FIGCAPTION", "CAPTION", "SUMMARY",
]);

function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    console.error(`界面元素缺失：#${id}`); // A4：技术细节只进 console，使用者只看下一行
    throw new Error("界面资源未就绪，请重启墨读");
  }
  return el as T;
}

/** 最近的块级祖先（上溯到 root 为止）；没有则归 root */
function nearestBlock(node: Node, root: Element): Element {
  let el = node.parentElement;
  while (el !== null && el !== root) {
    if (BLOCK_TAGS.has(el.tagName)) {
      return el;
    }
    el = el.parentElement;
  }
  return root;
}

/** RegExp 元字符转义：查询串按字面量匹配（本查找条没有正则模式） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 偏移 → 所属文本节点；块内片段不重叠且按文档序升序 */
function spanAt(spans: readonly TextSpan[], offset: number): TextSpan | null {
  for (const span of spans) {
    if (offset >= span.from && offset < span.to) {
      return span;
    }
  }
  return null;
}

/**
 * 清掉 root 内全部查找 mark：把 mark 的子节点放回原位并合并相邻文本节点。
 *
 * P0-4：这里用 childNodes 而非 textContent——跨节点命中时 mark 里可能裹着原有的
 * `<strong>`/`<em>` 等内联元素，用 textContent 会把它们压平成纯文本。
 * 无论哪种方式，字符序列（textContent）都逐字节不变，复制保真红线不受影响。
 */
export function clearFindMarks(root: Element): void {
  for (const mark of Array.from(root.querySelectorAll("mark.find-hit"))) {
    const parent = mark.parentNode;
    if (parent !== null) {
      mark.replaceWith(...Array.from(mark.childNodes));
      parent.normalize();
    }
  }
}

/**
 * 收集全部命中（文档序）。
 *
 * P0-4 修复：旧实现逐个文本节点 `indexOf`，因此**任何跨文本节点的可见连续文字都搜不到**——
 * pangu 会在 CJK↔拉丁边界插入**空** `.cjk-gap` span 把文本节点切开，
 * tok-break 的长 token 包裹、`strong`/`em`/`a`/`code` 等内联元素同样会切开。
 * 实测：正文「中文English混排」搜 `中文English` 返回 0/0，搜 `中文` 或 `English` 正常。
 *
 * 现按「最近的块级祖先」把块内文本节点拼成一串，并建立「字符偏移 → 文本节点」映射，
 * 在拼接串上匹配后再换算回节点坐标；空 span 不占偏移，也不阻断匹配。
 * 不同块之间不拼接，所以跨段落不会被误命中。
 */
function collectHits(root: Element, needle: string): TextHit[] {
  const hits: TextHit[] = [];
  if (needle === "") {
    return hits;
  }
  const groups = new Map<Element, Text[]>();
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
    if (text.data === "") {
      continue; // pangu/tok-break 的空 span：不占偏移，也不阻断匹配
    }
    const block = nearestBlock(text, root);
    const list = groups.get(block);
    if (list === undefined) {
      groups.set(block, [text]);
    } else {
      list.push(text);
    }
  }

  const source = escapeRegExp(needle);
  for (const nodes of groups.values()) {
    const spans: TextSpan[] = [];
    let joined = "";
    for (const node of nodes) {
      const from = joined.length;
      joined += node.data;
      spans.push({ node, from, to: joined.length });
    }
    // 在拼接串上按字面量做大小写不敏感匹配；matchAll 的 index 即原始串偏移，
    // 避免了 toLowerCase 改变长度（如 'İ'）导致偏移错位。
    for (const match of joined.matchAll(new RegExp(source, "gi"))) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const startSpan = spanAt(spans, start);
      const endSpan = spanAt(spans, end - 1);
      if (startSpan === null || endSpan === null) {
        continue;
      }
      hits.push({
        startNode: startSpan.node,
        startOffset: start - startSpan.from,
        endNode: endSpan.node,
        endOffset: end - endSpan.from,
      });
    }
  }
  return hits;
}

/**
 * 倒序包裹：先拆后文的文本节点不影响前文偏移；返回文档序的 mark 数组。
 * 同一文本节点走 surroundContents（快且不动结构）；跨节点命中把区间内容搬进 mark
 * ——Range 绝不跨块（collectHits 已按块分组），不会把段落劈开。
 */
function wrapHits(hits: readonly TextHit[]): HTMLElement[] {
  const marks: HTMLElement[] = [];
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    const range = document.createRange();
    range.setStart(hit.startNode, hit.startOffset);
    range.setEnd(hit.endNode, hit.endOffset);
    const mark = document.createElement("mark");
    mark.className = "find-hit";
    if (hit.startNode === hit.endNode) {
      range.surroundContents(mark);
    } else {
      mark.append(range.extractContents());
      range.insertNode(mark);
    }
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
