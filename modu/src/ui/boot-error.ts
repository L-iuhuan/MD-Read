/**
 * 启动失败兜底（P1-7）。
 *
 * 背景：index.html 的防闪内联样式是 `html:not(.app-ready) body { visibility: hidden }`，
 * 而 `.app-ready` 只在 boot() **跑完** 才加上。此前 boot() 若抛异常（界面元素缺失、
 * 偏好存储异常、插件调用失败……），`.app-ready` 永远加不上——窗口一片空白、
 * body 永久不可见，用户既看不到错也不知道能做什么。本模块就是那条兜底：
 *
 *   1. `revealBootFailure()` —— 摘掉隐藏、把中文失败说明画到界面上；
 *   2. `installBootWatchdog()` —— 兜底中的兜底：即使 boot 既不返回也不抛错
 *      （await 挂死、插件首次调用永不 resolve），超时也强制放行首帧，绝不留白窗。
 *
 * 本模块只碰 DOM，不 import 任何应用模块——兜底路径本身必须是最短依赖链，
 * 否则「兜底也炸」时用户还是白窗（widget 里的 showBootFailure 再套 try/catch 就是为此）。
 */

/** 兜底放行首帧的时限：正常 boot 落在百毫秒级，5s 只会命中真卡死的启动。 */
export const BOOT_WATCHDOG_MS = 5_000;

/** 失败面板的节点 id（幂等判据 + 样式钩子；样式在本模块内联，见下）。 */
const PANEL_ID = "boot-error";

/**
 * 失败面板样式走内联注入而非 app.css：面板按定义只在「样式表可能压根没加载
 * 成功 / boot 已经炸了」时出现，外部样式表这时并不可信；且 #app 内的规则
 * 对挂在 body 上的本面板无效。配色取 CSS 系统色（不依赖 tokens 变量——
 * tokens 由 app.css 侧引入，boot 失败时未保证可用）。
 */
const PANEL_STYLE = `
#${PANEL_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  padding: 24px;
  background: Canvas;
  color: CanvasText;
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 14px;
}
#${PANEL_ID} .boot-error-card {
  max-inline-size: 44rem;
  padding: 24px;
  background: Canvas;
  color: CanvasText;
  border: 1px solid;
  border-radius: 9px;
}
#${PANEL_ID} h1 { margin: 0 0 12px; font-size: 16px; font-weight: 600; }
#${PANEL_ID} p { margin: 0 0 12px; line-height: 1.7; }
#${PANEL_ID} pre {
  margin: 0;
  padding: 12px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: color-mix(in oklab, CanvasText 8%, Canvas);
  border-radius: 5px;
  font-size: 12px;
}`;

function injectPanelStyle(): void {
  if (document.getElementById(`${PANEL_ID}-style`) !== null) {
    return;
  }
  const style = document.createElement("style");
  style.id = `${PANEL_ID}-style`;
  style.textContent = PANEL_STYLE;
  document.head.appendChild(style);
}

/** 把 throwable 压成一行可读文本（不抛异常：兜底路径不许在格式化上再炸一次）。
 *  非 Error 的抛出物优先 JSON 化——`[object Object]` 对排查毫无价值；
 *  JSON 化本身可能抛（循环引用、自定义 toJSON），失败再退回 String()。 */
function describeFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message === "" ? String(error) : error.message;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** 挂上面板（幂等：重复调用只留一块面板，避免多次失败叠成一摞）。 */
function showBootFailure(details: string): void {
  try {
    document.getElementById(PANEL_ID)?.remove();
    injectPanelStyle();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "alert");
    const card = document.createElement("div");
    card.className = "boot-error-card";
    const heading = document.createElement("h1");
    heading.textContent = "墨读启动失败";
    const hint = document.createElement("p");
    hint.textContent =
      "界面没能正常加载，请关闭窗口后重新打开墨读。若反复出现，请把下面这行信息一并反馈。";
    const detail = document.createElement("pre");
    detail.textContent = details;
    card.append(heading, hint, detail);
    panel.appendChild(card);
    document.body.appendChild(panel);
  } catch (cause) {
    // 面板都画不出来（DOM 已不可信）：还有看门狗那条路，这里不再往上抛
    console.warn("启动失败提示无法显示", cause);
  }
}

/**
 * 启动失败兜底入口：**先摘掉 body 的隐藏**，再画失败说明。
 * 顺序不可颠倒也不能合并进 try——画面板失败时首帧已经放行，
 * 用户至少能看到一块（可能简陋的）界面，而不是永久白窗。
 * 正常启动路径不会调用本函数（那时 .app-ready 由 boot 自己加）。
 */
export function revealBootFailure(error: unknown): void {
  document.documentElement.classList.add("app-ready");
  showBootFailure(describeFailure(error));
}

/**
 * 安装看门狗：`ms` 内没等到 `settle()` 就强制放行首帧（不画失败面板——
 * boot 只是慢，界面稍后自己会出来，多一块错面板反而是误报）。
 * @returns 拆除函数；boot 正常收场时调用（成功或失败都已由调用方放行首帧）
 */
export function installBootWatchdog(ms: number = BOOT_WATCHDOG_MS): () => void {
  const timer = setTimeout(() => {
    document.documentElement.classList.add("app-ready");
    console.warn("启动超时，已强制显示界面");
  }, ms);
  return () => clearTimeout(timer);
}
