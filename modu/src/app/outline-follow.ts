/**
 * 大纲跟随（F4）· X2（2026-09-23 第二批）：把「IntersectionObserver 全量观察全部标题」
 * 换成「每帧对标题做一次实时二分」。
 *
 * 为什么（性能实验 §3.2/§3.3）：旧实现 `observeHeadings()` 对 **4,715** 个标题逐个
 * `observe`，Blink 每帧为它们重算相交矩形 —— `IntersectionObserverController::computeIntersections`
 * 占滚动墙钟 **26.3%（确定性驱动 1,575ms/6.0s，6.5ms/帧）～33.6%（真实滚轮 3,360ms/10s，
 * 17.2ms/帧）**，是两轮 trace 的第一名单点，单它就超过 13.3ms 的 vsync 预算。
 * 新实现每帧只读 **log₂(4715) ≈ 13 次** `getBoundingClientRect`（外加 2~3 次候选判定），
 * 与旧路径每帧最多 9,429 次 rect（`firstVisibleLine`，占墙钟 8.6~12.5%）相比是三个数量级以下的量。
 *
 * 为什么不是「渲染期预计算偏移表 + 二分」：`content-visibility:auto` 让未渲染块按
 * `contain-intrinsic-size: auto 2lh` 估高，报告实测首轮 `scrollHeight` 会长 **+13.6%**
 * （835,362 → 949,358px）⇒ 预计算的偏移会失真、必须反复失效重建；而**实时 rect 永远精确**
 * （旧 IO 版用的也是实时几何）。实时几何还顺带免掉了所有失效触发点：字号/行宽/字体变化、
 * 窗口尺寸变化、`content-visibility` 揭示、编辑↔阅读切态、正文重渲 —— 都不需要重建。
 * 也**不使用 `offsetTop`**（那要自己论证 offsetParent 链），直接拿视口坐标与
 * `#content` 的 rect.top 比较，参照系一目了然。
 *
 * 等价性推导（旧逻辑 = 在 IO 可见集合里取 |rect.top| 最小者）：
 *   「可见」= 元素盒与 `#content` 可视带相交 ⇒ `bottom > contentTop && top < contentTop + clientHeight`。
 *   标题按文档序排列且互不重叠（块级元素）⇒ 可见集合是连续区间 [p, q]；而
 *   `|top − contentTop|` 在区间内先减后增，最小值只可能在两个位置：
 *     ① `i` = 最后一个 `top ≤ contentTop` 的标题（且其 `bottom > contentTop` 才可见）
 *     ② `i + 1`（且其 `top < contentTop + clientHeight` 才可见）
 *   故只判这两个候选即可，与旧逐条比较**逐点等价**。
 *   两者都不可见 ⇒ 与旧版 `best === null` 一致：**保持上一次高亮不动**。
 *   id 为空的标题胜出时同样不动（旧版 `best.id !== ""` 才写）。
 *
 * 「当前项没变就不碰 DOM」是主要收益之一（旧版每次变化对 **全部 4,715** 条链接各调一次
 * `classList.toggle`，10 秒滚动实测 **2,187,760 次** JS 调用 = 每帧 14,299 次；本实现只在
 * 当前项真的变化时做 1 次 remove + 1 次 add）。rAF 节流仍由调用方 `scheduleFollow` 保证。
 */

/** 参与跟随的标题选择器（与旧 `observeHeadings` 完全一致） */
const HEADINGS = "h1,h2,h3,h4,h5,h6";

export interface OutlineFollowDeps {
  /** 滚动容器（#content） */
  content(): HTMLElement;
  /** 正文容器（#doc） */
  doc(): HTMLElement;
  /** 大纲链接表（id → <a>），由 main.ts 的 mountOutline 维护 */
  links(): ReadonlyMap<string, HTMLAnchorElement>;
}

export interface OutlineFollow {
  /** 正文已换（mountRendered）/ 回到空态：重建标题元素列表（只查 DOM，不读几何） */
  reset(): void;
  /** 滚动帧内调用一次（调用方已 rAF 节流）：返回是否真的改写了 DOM（便于计数/单测） */
  update(): boolean;
}

/** 一个候选：标题元素 + 它的 top 到可视带上沿的距离 */
interface Candidate {
  el: HTMLElement;
  dist: number;
}

/** 二分：最后一个 `top ≤ contentTop` 的下标；不存在返回 -1（标题按文档序 = top 升序） */
function lastAtOrAbove(headings: readonly HTMLElement[], contentTop: number): number {
  let lo = 0;
  let hi = headings.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].getBoundingClientRect().top <= contentTop) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** 该下标是否是「可见」的候选（等价于 IO 的相交判定）+ 它到可视带上沿的距离 */
function candidateAt(
  headings: readonly HTMLElement[],
  index: number,
  contentTop: number,
  contentBottom: number
): Candidate | null {
  const el = headings[index];
  if (el === undefined) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  if (rect.bottom <= contentTop || rect.top >= contentBottom) {
    return null;
  }
  return { el, dist: Math.abs(rect.top - contentTop) };
}

/** 在两个候选里取「离可视带上沿更近」的那个（= 旧版在可见集合里取 min|rect.top| 的等价形式） */
function nearest(above: Candidate | null, below: Candidate | null): Candidate | null {
  if (above === null) {
    return below;
  }
  if (below === null) {
    return above;
  }
  return below.dist < above.dist ? below : above;
}

export function createOutlineFollow(deps: OutlineFollowDeps): OutlineFollow {
  /** 标题元素列表（文档序 = top 升序）；只在 reset 时重建 Element 引用，不缓存几何 */
  let headings: HTMLElement[] = [];
  let activeId: string | null = null;

  function reset(): void {
    const doc = deps.doc();
    headings = doc.hidden ? [] : Array.from(doc.querySelectorAll<HTMLElement>(HEADINGS));
    activeId = null; // 正文已换：旧高亮随旧链接一起作废（mountOutline 会建全新链接）
  }

  function update(): boolean {
    if (headings.length === 0) {
      return false;
    }
    const content = deps.content();
    const contentTop = content.getBoundingClientRect().top;
    const contentBottom = contentTop + content.clientHeight;
    const i = lastAtOrAbove(headings, contentTop);
    const winner = nearest(
      candidateAt(headings, i, contentTop, contentBottom),
      candidateAt(headings, i + 1, contentTop, contentBottom)
    );
    if (winner === null || winner.el.id === "" || winner.el.id === activeId) {
      return false; // 无可见标题 / 标题无 id / 当前项未变 —— 一律不碰 DOM
    }
    const id = winner.el.id;
    const links = deps.links();
    const link = links.get(id);
    if (link === undefined) {
      // 理论上不可达（大纲条目与 DOM 标题同源）。真出现时按旧版语义清空高亮，别留错的高亮。
      for (const other of links.values()) {
        other.classList.remove("active");
      }
      activeId = null;
      return true;
    }
    if (activeId !== null) {
      links.get(activeId)?.classList.remove("active");
    }
    link.classList.add("active");
    activeId = id;
    return true;
  }

  // ⚠ 这里**不**做初值 reset：deps 取 DOM 是惰性的，实例创建本身不碰 DOM
  // （main.ts 在模块级创建它，那时不该有任何 DOM 依赖）；调用方在
  // mountRendered / resetToWelcome 各 reset 一次即可，空列表时 update() 直接返回 false。
  return { reset, update };
}