/**
 * 清空"最近列表"（`localStorage['modu-recent']`）——**受控维护工具**，用于清理测试污染。
 *
 * 前置条件（缺一即拒绝执行）：
 *  1) 应用已启动、CDP 可达；
 *  2) **必须**给 `--expect-keep <json>`：一个文件，内容是"清理后期望保留的条目数组"（形如 `[]`）。
 *     本工具会把"写回后重新读出来的值"与它**逐条比对**（不是只比条数）；
 *  3) 必须给 `--before <json>`：清理前 dump（本工具会先复核"当前值 == before"，不符即拒绝）。
 *
 * ⚠ 纪律：
 *  - **不打开任何文件**（本工具只动 localStorage；调用方的启动包装负责受信清单快照/还原）；
 *  - 写回后**重新读一次**并与 `--expect-keep` 逐条比对；
 *  - 顺带采集**空态渲染证据**（最近列表 UI 内容 + 控制台报错），供"空列表不报错"验收。
 *
 * 用法：node tests/tools/clear-recent.mjs --before <before.json> --expect-keep <keep.json> [--port 9222] [--key modu-recent]
 *   before/keep 两个 json 的格式：既可是纯数组，也可是 { entries: [...] }（兼容 dump-recent 的输出）
 */
import { existsSync, readFileSync } from 'node:fs';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}
const key = typeof args.key === 'string' ? args.key : 'modu-recent';
const beforeFile = args.before;
const keepFile = args['expect-keep'];
if (typeof beforeFile !== 'string' || typeof keepFile !== 'string') {
  console.error('用法：node tests/tools/clear-recent.mjs --before <before.json> --expect-keep <keep.json> [--port 9222]');
  process.exit(2);
}
const readEntries = (file) => {
  if (!existsSync(file)) {
    console.error(`[前置检查失败] 找不到 ${file}`);
    process.exit(2);
  }
  // 容忍 BOM（PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM，JSON.parse 会因此失败）
  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return Array.isArray(parsed) ? parsed.map(String) : (parsed.entries ?? []).map(String);
};
const before = readEntries(beforeFile);
const expectKeep = readEntries(keepFile);

async function connectCdp(pagePort) {
  const list = await (await fetch(`http://127.0.0.1:${pagePort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  if (target === undefined) throw new Error('未找到 CDP page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method !== undefined) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails !== undefined) throw new Error(res.result.exceptionDetails.text ?? '页面求值异常');
    return res.result?.result?.value;
  };
  return { send, evaluate, events, close: () => ws.close() };
}

const out = { key, beforeFile, keepFile, expectKeepCount: expectKeep.length };
let client = null;
try {
  client = await connectCdp(Number(args.port ?? 9222));
  await client.send('Runtime.enable');
  // 等就绪信号（不许固定 sleep）
  const deadline = Date.now() + 90_000;
  let hook = null;
  while (Date.now() < deadline) {
    hook = await client.evaluate(`typeof window.__moduDev`);
    if (hook === 'object') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (hook !== 'object') throw new Error('等待 window.__moduDev 超时（应用未就绪或 dev 钩子未注入）');

  // ⚠ 必须区分"**键不存在（null）**"与"**空数组（`[]`）**"：曾因 `?? '[]'` 把两者混为一谈而误判（真实翻车）
  const currentRaw = await client.evaluate(`localStorage.getItem(${JSON.stringify(key)})`);
  out.currentRaw = currentRaw;
  out.currentKeyAbsent = currentRaw === null;
  const current = currentRaw === null ? [] : JSON.parse(currentRaw);
  out.currentCount = current.length;
  out.currentMatchesBefore = JSON.stringify(current) === JSON.stringify(before);
  if (!out.currentMatchesBefore) {
    throw new Error(`前置检查失败：当前值与 --before 不一致（当前 ${current.length} 条）⇒ 拒绝写回`);
  }

  // 写回期望值，然后**重新加载**让应用内存态也从 localStorage 重读（避免关闭时把旧值写回）
  await client.evaluate(`localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(expectKeep))})`);
  await client.send('Page.enable');
  await client.send('Page.reload', { ignoreCache: false });
  const reloadDeadline = Date.now() + 60_000;
  let after = null;
  while (Date.now() < reloadDeadline) {
    try {
      after = JSON.parse(await client.evaluate(`localStorage.getItem(${JSON.stringify(key)}) ?? '[]'`));
      if (Array.isArray(after)) break;
    } catch {
      /* 重载中，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  out.afterReload = after;
  out.afterCount = Array.isArray(after) ? after.length : null;
  out.matchesExpectedKeep = JSON.stringify(after) === JSON.stringify(expectKeep);
  // 空态渲染证据：最近列表 UI 内容 + 控制台报错
  const uiProbe = `(() => {
    const nodes = Array.from(document.querySelectorAll('#recent, .recent, #recent-list, [data-recent], #st-recent'));
    const text = (document.body.innerText || '').slice(0, 400);
    return { found: nodes.length, samples: nodes.map((n) => ({ id: n.id, cls: n.className, text: (n.textContent || '').slice(0, 120) })), bodyStartsWith: text.slice(0, 120) };
  })()`;
  out.emptyStateUi = await client.evaluate(uiProbe);
  out.consoleErrors = client.events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'))
    .map((e) => (e.params?.exceptionDetails?.text ?? e.params?.args?.map((a) => a.value ?? a.description).join(' ') ?? '').slice(0, 200));
} catch (error) {
  out.error = String(error);
} finally {
  if (client !== null) {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
}
console.log(JSON.stringify(out, null, 1));
