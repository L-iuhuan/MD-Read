/**
 * probe-align.mjs —— 【生产构建】编辑态行号/内容对齐 + 运行时注入样式（CSP）真机探针。
 *
 * 为什么必须跑生产 exe：Tauri v2 打包时会改写 CSP（给 script-src/style-src 注入 nonce+hash），
 * 运行时 `<style>`（CM6/style-mod）因此在生产里可能被 style-src-elem 拦截；vite dev 没有这层 CSP
 * ⇒ 只跑 `tauri dev` 的验收会漏掉「编辑态行号/内容几何全乱」这个装机版缺陷（2026-10-20 定案，
 * 见 modu/AGENTS.md「生产 CSP 与运行时注入样式」节）。
 *
 * 前置：应用已用 CDP 端口启动（生产 exe）：
 *   $env:WEBVIEW2_USER_DATA_FOLDER='<隔离目录>'; $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
 *   启动 modu.exe <绝对路径.md>   →   再跑本探针
 * 用法：node tests/tools/probe-align.mjs [--port 9222] [--out .verify/align/run-<ts>] [--expect-version 0.2.8]
 *
 * 判据（数值）：
 *  1) style-src 含 'unsafe-inline' 且不含 nonce/hash；CM6 注入的 <style> 有 sheet（sheetNull=false）；
 *  2) .cm-scroller display=flex、字号 = 16px × 缩放档、.cm-gutters 字号同源；
 *  3) 编辑态可见行号与 `.cm-line` 逐行 top 差 dy ≤ 1px；行号在正文左侧（水平间距 0~40px）；
 *  4) 90/100/110/125/150 五档缩放、长文滚动后、阅读/编辑二次进出：dy 仍 ≤1px；
 *  5) .cm-editor 上没有 CSS zoom（防 0.2.7 之前的根因复发）。
 * 输出：<out>/report.json + 各状态截图；有 FAIL 时退出码 1。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectToPage } from "./cdp.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1];
}
const port = Number(args.port ?? 9222);
const expectVersion = args["expect-version"] ?? null;
const outDir = args.out ?? `.verify/align/run-${Date.now()}`;
mkdirSync(outDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), steps: [], fail: [] };
const fail = report.fail;

const client = await connectToPage({
  port,
  timeout: 30000,
  match: (t) => t.type === "page" && (t.url ?? "").includes("tauri.localhost"),
});
await client.enableDomains();
const raf = () => client.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))");
async function waitFor(expr, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await client.evaluate(expr); } catch { v = null; }
    if (v === true) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}（${expr}）`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const shot = (name) => client.screenshot({ file: join(outDir, name + ".png") });
async function press(key, code, vk) {
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: 2, windowsVirtualKeyCode: vk, key, code });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, windowsVirtualKeyCode: vk, key, code });
  await raf();
}
const uiZoom = async () => Number(await client.evaluate("document.getElementById('set-zoom-val')?.textContent"));
async function gotoZoom(target) {
  for (let guard = 0; guard <= 8; guard += 1) {
    const cur = await uiZoom();
    if (cur === target) return cur;
    const up = target > cur;
    await press(up ? "=" : "-", up ? "Equal" : "Minus", up ? 187 : 189);
    await new Promise((r) => setTimeout(r, 350));
  }
  return uiZoom();
}

/* ---------- 1) CSP / 样式注入 ---------- */
await waitFor("document.querySelector('#doc:not([hidden])') !== null", 30000, "文档就绪");
await raf();
const csp = await client.evaluate(`(async () => {
  try { const r = await fetch(location.href, { cache: 'no-store' }); return r.headers.get('content-security-policy') || ''; }
  catch (e) { return 'FETCH_ERROR: ' + String(e); }
})()`);
const styleSrc = (csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("style-src")) ?? "(none)");
report.csp = { full: csp, styleSrc };
if (/'nonce-|'sha(256|384|512)-/.test(styleSrc)) fail.push(`style-src 仍含 nonce/hash（'unsafe-inline' 会被忽略）：${styleSrc}`);
if (!/'unsafe-inline'/.test(styleSrc)) fail.push(`style-src 缺 'unsafe-inline'：${styleSrc}`);

const styles = await client.evaluate(`(() => {
  const tags = [...document.querySelectorAll('style')].map((s) => ({ len: (s.textContent || '').length, sheetNull: s.sheet === null, start: (s.textContent || '').slice(0, 60) }));
  const pick = (el) => el === null ? null : (() => { const cs = getComputedStyle(el); return { display: cs.display, position: cs.position, fontSize: cs.fontSize, lineHeight: cs.lineHeight, className: (el.className || '').slice(0, 80) }; })();
  const cm = document.querySelector('.cm-editor');
  return {
    sheetCount: document.styleSheets.length,
    cmStyleTags: tags.filter((t) => t.start.includes('cm-')),
    editor: pick(cm), scroller: pick(document.querySelector('.cm-scroller')),
    gutters: pick(document.querySelector('.cm-gutters')), content: pick(document.querySelector('.cm-content')),
    cmRootInline: cm === null ? null : cm.getAttribute('style'), cmRootZoom: cm === null ? null : getComputedStyle(cm).zoom,
    dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight, screenW: screen.width, screenH: screen.height,
  };
})()`);
report.styles = styles;
if (styles.cmStyleTags.length === 0) fail.push("未找到 CM6 注入的 style 标签");
if (styles.cmStyleTags.some((t) => t.sheetNull)) fail.push("CM6 注入的 style 标签 sheet=null（被 CSP 拦截）");
if (styles.scroller?.display !== "flex") fail.push(`.cm-scroller display=${styles.scroller?.display}（期望 flex）`);
const versionText = await client.evaluate("document.getElementById('settings-version')?.textContent ?? null");
report.versionText = versionText;
if (expectVersion !== null && !String(versionText ?? "").includes(expectVersion)) {
  fail.push(`版本串不含 ${expectVersion}（实际 ${versionText}）⇒ 被测 exe 不是本轮构建`);
}

/* ---------- 2) 逐行度量 ---------- */
async function measure(zoom) {
  return client.evaluate(`(() => {
    const sc = document.querySelector('.cm-scroller');
    if (sc === null) return { error: 'no scroller' };
    const scRect = sc.getBoundingClientRect();
    const inView = (r) => r.bottom > scRect.top + 1 && r.top < scRect.bottom - 1;
    const gut = [...document.querySelectorAll('.cm-gutterElement')].map((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { n: parseInt((el.textContent || '').trim(), 10), top: r.top, bottom: r.bottom, height: r.height, right: r.right, hidden: cs.visibility === 'hidden' || r.height < 1 };
    }).filter((g) => Number.isFinite(g.n) && !g.hidden && inView({ top: g.top, bottom: g.bottom }));
    const lines = [...document.querySelectorAll('.cm-line')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left };
    }).filter((l) => inView(l));
    const rows = [];
    if (gut.length === lines.length) {
      for (let i = 0; i < gut.length; i += 1) rows.push({ n: gut[i].n, dy: +(lines[i].top - gut[i].top).toFixed(2), gap: +(lines[i].left - gut[i].right).toFixed(2) });
    } else {
      for (const g of gut) {
        let best = null; let bestD = Infinity;
        for (const l of lines) { const d = Math.abs(l.top - g.top); if (d < bestD) { bestD = d; best = l; } }
        if (best !== null) rows.push({ n: g.n, dy: +(best.top - g.top).toFixed(2), gap: +(best.left - g.right).toFixed(2), fuzzy: true });
      }
    }
    const dys = rows.map((r) => r.dy);
    const gaps = rows.map((r) => r.gap);
    const cs = (sel) => { const el = document.querySelector(sel); return el === null ? null : getComputedStyle(el); };
    return {
      countGutter: gut.length, countLines: lines.length, rowCount: rows.length, rows: rows.slice(0, 8),
      maxAbsDy: dys.length === 0 ? null : Math.max(...dys.map(Math.abs)),
      over1px: rows.filter((r) => Math.abs(r.dy) > 1).length,
      gapMin: gaps.length === 0 ? null : Math.min(...gaps), gapMax: gaps.length === 0 ? null : Math.max(...gaps),
      scrollerFont: cs('.cm-scroller')?.fontSize, gutterFont: cs('.cm-gutters')?.fontSize,
      lineHeight: cs('.cm-line')?.lineHeight, editorZoom: cs('.cm-editor')?.zoom,
      scrollTop: sc.scrollTop, scrollHeight: sc.scrollHeight,
      zoomVal: document.getElementById('set-zoom-val')?.textContent,
      mode: { docHidden: document.getElementById('doc')?.hidden, paneHidden: document.getElementById('editor-pane')?.hidden },
    };
  })()`);
}
function check(label, zoom, m) {
  report.steps.push({ label, zoom, m });
  if (m.error !== undefined) { fail.push(`${label}: ${m.error}`); return; }
  if (m.maxAbsDy === null) fail.push(`${label}: 没有可测量行`);
  else if (m.maxAbsDy > 1) fail.push(`${label}: 逐行 dy 最大 ${m.maxAbsDy}px（>1px）`);
  if (m.over1px > 0) fail.push(`${label}: ${m.over1px} 行 dy>1px`);
  if (m.gapMin !== null && (m.gapMin < -1 || m.gapMax > 40)) fail.push(`${label}: 行号/正文水平间距异常 [${m.gapMin}, ${m.gapMax}]`);
  if (Math.abs(parseFloat(m.scrollerFont) - 16 * (zoom / 100)) > 0.6) fail.push(`${label}: 正文 ${m.scrollerFont} ≠ 期望 ${16 * (zoom / 100)}px`);
  if (m.gutterFont !== m.scrollerFont) fail.push(`${label}: 行号字号 ${m.gutterFont} ≠ 正文 ${m.scrollerFont}`);
  if (m.editorZoom !== "1" && m.editorZoom !== "normal") fail.push(`${label}: .cm-editor 出现 CSS zoom=${m.editorZoom}（根因复发表征）`);
  if (m.mode.docHidden !== true || m.mode.paneHidden !== false) fail.push(`${label}: 未处于编辑态`);
}

/* ---------- 3) 编辑态五档 + 滚动 + 二次进出 ---------- */
await press("0", "Digit0", 48);
await client.evaluate("document.getElementById('btn-edit').click(); true");
await raf();
await new Promise((r) => setTimeout(r, 500));
check("edit@100", 100, await measure(100));
await shot("edit-100");
for (const z of [110, 125, 150, 90, 100]) {
  const ui = await gotoZoom(z);
  await new Promise((r) => setTimeout(r, 400));
  check(`edit@${ui}`, ui, await measure(ui));
  await shot(`edit-${ui}`);
}
await gotoZoom(125);
await new Promise((r) => setTimeout(r, 300));
report.scrollProbe = await client.evaluate(`(async () => {
  const sc = document.querySelector('.cm-scroller'); sc.scrollTop = 4200;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 250))));
  return { top: sc.scrollTop, height: sc.scrollHeight };
})()`);
check("edit@125-scrolled", 125, await measure(125));
await shot("edit-125-scrolled");
await client.evaluate("document.getElementById('btn-edit').click(); true");
await raf(); await new Promise((r) => setTimeout(r, 500));
await client.evaluate("document.getElementById('btn-edit').click(); true");
await raf(); await new Promise((r) => setTimeout(r, 500));
check("edit@reenter", 125, await measure(125));
await shot("edit-reenter");

report.finishedAt = new Date().toISOString();
report.pass = fail.length === 0;
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
console.log("[probe-align] CSP =", styleSrc);
console.log("[probe-align] CM6 style sheets =", JSON.stringify(styles.cmStyleTags.map((t) => ({ sheetNull: t.sheetNull, len: t.len }))), "| scroller", styles.scroller?.display, styles.scroller?.fontSize, "| dpr", styles.dpr);
console.log("[probe-align] steps =", JSON.stringify(report.steps.map((s) => ({ label: s.label, maxAbsDy: s.m?.maxAbsDy, gut: s.m?.countGutter, line: s.m?.countLines, font: s.m?.scrollerFont, gap: [s.m?.gapMin, s.m?.gapMax] }))));
console.log("[probe-align] fail =", JSON.stringify(fail));
console.log("[probe-align] report =", join(outDir, "report.json"));
client.close();
if (fail.length > 0) process.exitCode = 1;
