/**
 * 顶栏拥挤态（D-05 定稿）—— 批次 3-7 自 `main.ts` **整段搬移**（逐字，不改语义）。
 *
 * ⚠ 搬移纪律：本文件内容与 `main.ts` 改前对应段**逐字相同**（仅 `$` → `req` 的导入替换）；
 *   锚：`tests/panel-unify.spec.ts`（拥挤态判据只用与开合无关的量、ResizeObserver + MutationObserver）。
 */
import { req } from "./dom";

/* ---- 顶栏拥挤态（D-05 定稿；2026-09-23 第二批把判据整个换掉）----
   判据（本批改写）：**标签装不下了** —— 标签总宽（含 ＋）> 标签条在“展开态”的可用宽度，
   后者 = 视口宽 − 顶栏除标签条外的固定占用（tokens.css 的 --w-chrome-reserve）。

   ⚠ 旧判据读的是 **bar.clientWidth**（标签条可分宽度）与 420px 比较。那是错的：
   `flex: 1 1 0` 让标签条宽度**只由窗口宽度决定**，与标签数量无关（标签是
   `flex: 0 0 auto` + 上限 200px，装不下就在条内横向滚动）——后果是新默认窗口
   1680×1200 下打开再多文件也不会收起（实测标签条约 1140px，恒 > 420px），
   折叠功能实际不可达。更糟的是 bar.clientWidth **会随 .overflow 自己变化**
   （收起动作组后让出 161px），于是「收起 → 变宽 → 超过放开判据 → 放开 → 变窄 →
   又低于收起判据」形成自激；旧注释里那 240px 的 TABS_EXPAND_MARGIN 就是为压住
   这种自激校准出来的（0 翻转是拿余量换来的）。

   新判据的两项**都与开合状态无关**：标签总宽只随标签数量/名字变；视口宽不因收起而变
   ⇒ 结构上不可能自激。滞回余量因此退化为亚像素/取整边界的防御性冗余（16px），
   不再需要按「收起让出多少」校准。

   两项怎么取：
   · 标签总宽 = #tab-list 所有孩子（.tab / .tab-sep / ＋）的 offsetWidth 之和
     （.tab-list 的 gap 为 0、孩子无 margin，故和 = 内容宽度）。标签禁收缩（flex: 0 0 auto）
     ⇒ 这个和不受容器宽度影响，这正是它能当判据的原因。
   · 视口宽 = document.documentElement.clientWidth（body 恒 overflow:hidden，无滚动条干扰）。
   · --w-chrome-reserve 取**导航组 ‹ › ▾ 未出现**时的固定占用：判据边界上标签恰好装得下，
     导航组本就该是隐的，两者自洽（见 tokens.css 该 token 的实测读数）。
   · 参考读数（仅作对照，不要再拿它当判据依据）：1680×1200 下标签条约 1140px、
     900×750 窄窗下约 640px；收起动作组实测让出 161px。
   · 本批真机实测（1680×1200，靛蓝·亮，token 取 468）：3 标签（总宽 628）时
     收在 w=1094（avail 626 < 628）、放在 w=1114（avail 646 > 628+16），
     即 avail 上 16px 死区；宽度口径 1000→1160→1000 共 162 个采样点只翻 3 次
     （收 / 放 / 收，单调，无自激）。10 标签总宽 2035、20 标签 4045，均 > avail 1212 → 收。 */
const CHROME_RESERVE_DEFAULT = 460; // --w-chrome-reserve 缺席时的兜底（宁可多收，不能少收）
/** 折叠/展开之间的死区（px）：判据与开合无关，此值只吸收亚像素与整数量化误差 */
const TABS_FIT_DEADBAND = 16;

function chromeReserveWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--w-chrome-reserve");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHROME_RESERVE_DEFAULT;
}

/** 标签总宽（含 ＋）。逐个读 offsetWidth 而不是 scrollWidth：后者受滚动位置与
 *  sticky 位移影响，读出来的不是「标签想占多宽」。 */
function desiredTabsWidth(list: HTMLElement): number {
  let total = 0;
  for (const child of Array.from(list.children)) {
    total += (child as HTMLElement).offsetWidth;
  }
  return total;
}

export function setupShellOverflow(): void {
  const header = req<HTMLElement>("titlebar");
  const list = req<HTMLElement>("tab-list");
  const reserve = chromeReserveWidth();
  const update = (): void => {
    const avail = document.documentElement.clientWidth - reserve;
    const want = desiredTabsWidth(list);
    if (!header.classList.contains("overflow") && want > avail) {
      header.classList.add("overflow"); // 装不下 → 收成「编辑 + ⋯」
    } else if (header.classList.contains("overflow") && want < avail - TABS_FIT_DEADBAND) {
      header.classList.remove("overflow"); // 明显装得下 → 放开
    }
  };
  // 触发源一：视口宽变化（观察 documentElement —— 它等于视口宽，收起动作组不会改它）
  new ResizeObserver(update).observe(document.documentElement);
  // 触发源二：标签增删（renderBar 重建 #tab-list 的孩子；标签条的宽度不随之变化，
  // 所以只能靠这一条捕获「又多了一个标签」，旧实现漏的正是这里）
  new MutationObserver(update).observe(list, { childList: true });
  update(); // 初值现算（首次回调异步，窄窗启动时第一帧就要是对的）
}
