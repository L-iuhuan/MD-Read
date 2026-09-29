/**
 * cdp.mjs —— 零依赖的 Chrome DevTools Protocol（CDP）页面客户端。
 *
 * 用途：给 tests/tools 下的审计/探针工具一个统一的 CDP 入口——连上由 dev overlay
 *   （`.verify/dev/tauri.dev-cdp.conf.json` 的 `app.windows[].additionalBrowserArgs`
 *   = `--remote-debugging-port=9222`）开出来的 WebView2/Chromium 页面目标，
 *   收发 CDP 指令、求值 JS、截图。`docs/开发状态.md`「活体验证」节引用的
 *   connectToPage / evaluate / screenshot 三导出即本文件。
 *
 * 用法示例：
 *   import { connectToPage } from "../tools/cdp.mjs";
 *   const c = await connectToPage({ port: 9222 });     // 应用先以 overlay 起 CDP
 *   await c.enableDomains();
 *   await c.evaluate("document.body.focus()");          // 返回值已解包（returnByValue）
 *   await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
 *   await c.screenshot({ file: "shot.png" });           // 可选落盘
 *   await c.close();                                    // 只断开连接，不关应用
 *
 * 为何不入 vendor：本文件只依赖 Node ≥22 的全局 fetch / WebSocket / AbortSignal
 *   （CI 亦钉 Node 22+，见 .github/workflows/ci.yml），没有任何需要锁版本随库保存的
 *   三方代码 ⇒ 无 vendor 必要。同目录 clear-recent / probe-isolation / dump-origins
 *   各自内联过同类实现；本文件是抽出的公共版，行为口径与它们对齐：
 *   Runtime.evaluate 带 awaitPromise + returnByValue，返回解包后的值（不是 CDP 原始回包）。
 *
 * Node 版本要求：≥ 22（更低版本没有全局 WebSocket，import 本文件不影响，但连接会 ReferenceError）。
 */
import { writeFile } from "node:fs/promises";

const DEFAULT_PORT = 9222;
const CONNECT_TIMEOUT_MS = 15000; // 等 page target 出现：应用启动 + 端口监听需要时间（探针纪律：带超时等就绪，不固定 sleep）
const CALL_TIMEOUT_MS = 30000; // 单条 CDP 指令 / WebSocket 建连的上限

/** 拉 /json/list；拿不到（端口没开/没起应用）返回 null，由调用方轮询 */
async function fetchTargets(port, timeoutMs) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** 目标挑选：默认取 type === "page" 且非 devtools 前端；match 可传 string | RegExp | (target) => boolean */
function targetMatches(t, match) {
  if (typeof match === "function") return Boolean(match(t));
  if (typeof match === "string") return (t.url ?? "").includes(match) || (t.title ?? "").includes(match);
  if (match instanceof RegExp) return match.test(t.url ?? "") || match.test(t.title ?? "");
  return t.type === "page" && !(t.url ?? "").startsWith("devtools://");
}

/**
 * 连接到调试端口上的页面目标。
 * @param {{ port?: number, timeout?: number, match?: string | RegExp | ((t: object) => boolean) }} opts
 *   port    CDP 端口（kbd-audit 等消费方用 9222）
 *   timeout 等 target 出现的总时限（默认 15s；应用冷启动慢时可调大）
 *   match   多页面目标时用来挑目标；不给则取第一个普通 page
 * @returns {Promise<{ target: object, ws: WebSocket, send: Function, enableDomains: Function,
 *                     evaluate: Function, screenshot: Function, close: Function }>}
 */
export async function connectToPage({ port = DEFAULT_PORT, timeout = CONNECT_TIMEOUT_MS, match } = {}) {
  const deadline = Date.now() + timeout;
  let target;
  for (;;) {
    const rest = deadline - Date.now();
    const list = await fetchTargets(port, Math.min(2000, Math.max(1, rest)));
    target = (list ?? []).find((t) => targetMatches(t, match) && typeof t.webSocketDebuggerUrl === "string");
    if (target !== undefined || rest <= 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (target === undefined) {
    throw new Error(
      `CDP 127.0.0.1:${port} 上找不到页面目标（应用没起，或没按 overlay 开 --remote-debugging-port；` +
        `见 docs/开发状态.md「快速上手」的 tauri.dev-cdp.conf.json 一节）`,
    );
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`WebSocket 建连超时：${target.webSocketDebuggerUrl}`)), CALL_TIMEOUT_MS);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`WebSocket 连接失败：${target.webSocketDebuggerUrl}`)); }, { once: true });
  });

  let seq = 0;
  const pending = new Map(); // id → { resolve, reject, timer }
  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
    if (msg?.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(`CDP 回包报错：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    }
    // 带 id 的回包之外是事件通知，本客户端不消费（消费方要事件请走 c.send 自行订阅）
  });
  const failAll = () => {
    for (const { reject } of pending.values()) reject(new Error("CDP 连接已关闭"));
    pending.clear();
  };
  ws.addEventListener("close", failAll);
  ws.addEventListener("error", failAll);

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 指令超时：${method}`)); }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });

  return {
    target,
    ws,
    send,
    /** 打开常用域（Runtime/Page/Log；Input 域无需 enable） */
    enableDomains: async () => {
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Log.enable");
    },
    /** 求值并解包返回值；页面侧抛错时 reject（描述 + 表达式前 120 字） */
    evaluate: async (expression) => {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res?.exceptionDetails) {
        const d = res.exceptionDetails;
        throw new Error(`evaluate 抛错：${d.exception?.description ?? d.text ?? "(无描述)"}\n  <- ${expression.slice(0, 120)}`);
      }
      return res?.result?.value;
    },
    /** 截图：Page.captureScreenshot；给 file 则同时落盘（UTF-8 之外的二进制由 Buffer 写入） */
    screenshot: async ({ format = "png", file } = {}) => {
      const res = await send("Page.captureScreenshot", { format });
      if (file) await writeFile(file, Buffer.from(res.data, "base64"));
      return file === undefined ? { format, base64: res.data } : { format, base64: res.data, file };
    },
    /** 断开连接（不关应用、不关页面） */
    close: () => { ws.close(); },
  };
}

/** 独立求值：与连接对象上的 evaluate 同口径（模块三导出之一，见文件头） */
export function evaluate(client, expression) {
  return client.evaluate(expression);
}

/** 独立截图：与连接对象上的 screenshot 同口径（模块三导出之一，见文件头） */
export function screenshot(client, options) {
  return client.screenshot(options);
}
