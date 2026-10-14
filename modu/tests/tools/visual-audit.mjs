/**
 * visual-audit.mjs —— 墨读渲染产物的「几何/视觉」数值审查（CDP，零依赖）。
 *
 * 判据全部是数值：getBoundingClientRect / scrollWidth / clientWidth / naturalWidth，
 * 不做「看起来」的结论。输入是已渲染的 HTML 片段（一般由 tests/tools/render-probe.spec.ts
 * 用 PROBE_IN/PROBE_OUT 生成，$env:PROBE_OUT 下每个 *.html 即一篇正文）。
 *
 * 用法（Chrome 必须由 pwsh 先起，Node 里**不要** spawn —— 本沙箱 node child_process 被禁）：
 *   # 1) pwsh 起 Chrome（独立 user-data-dir，端口 9333）
 *   Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
 *     '--headless=new','--remote-debugging-port=9333','--no-first-run',`
 *     '--no-default-browser-check','--user-data-dir=<临时目录>','about:blank'
 *   # 2) Node 只走 fetch + WebSocket（cdp.mjs）
 *   node tests/tools/visual-audit.mjs --in .verify/audit/visual/corpus-out --out .verify/audit/visual/report-run
 *   # 3) pwsh Stop-Process -Name chrome -Force 收尾
 *
 * 变体：亮/暗 × 字号 16/24 × 行宽 46/80em，各自 cv-on / cv-off 两态。
 * 输出：<out>/visual-report.json（机器可读）+ 控制台人读摘要。
 *
 * ⚠ 本工具在无 renderer 的受限环境下会在 connectToPage 后立刻失败：page 目标上
 *   Browser.getVersion 能回、Runtime.evaluate 超时（renderer 起不来）。此时本工具
 *   打印 FATAL 指引并 exit 2，绝不用 0 值伪造测量结果。
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectToPage } from "./cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODU = resolve(HERE, "../..");
const CSS_FILES = [
  "src/app.css", "src/typography/tokens.css", "src/typography/cjk.css",
  "src/typography/print.css", "src/typography/hljs.css", "node_modules/katex/dist/katex.min.css",
];

/** 从 fitmath.ts 读缩放下限，保证页面内镜像算法与源码常量一致（不一致就报错） */
function readMathMinScale() {
  const src = readFileSync(join(MODU, "src/render/fitmath.ts"), "utf8");
  const m = /MATH_MIN_SCALE\s*=\s*([\d.]+)/.exec(src);
  if (m === null) throw new Error("无法从 src/render/fitmath.ts 读到 MATH_MIN_SCALE");
  return Number(m[1]);
}

function readCssBundle() {
  const fontsDir = pathToFileURL(join(MODU, "node_modules/katex/dist/fonts") + "/").href;
  const parts = [];
  for (const rel of CSS_FILES) {
    let css = readFileSync(join(MODU, rel), "utf8");
    if (rel.includes("katex")) css = css.replace(/url\(fonts\//g, "url(" + fontsDir);
    parts.push("/* === " + rel + " === */\n" + css);
  }
  return parts.join("\n");
}

/** 页面内审查脚本：与 src/render/fitmath.ts 的 fitMathBlock 同算法（审计镜像），
 *  外加测量函数。写成普通函数再 toString() 注入，避免字符串转义。 */
function browserAudit(MIN_SCALE) {
  function labelOf(el) {
    const cls = typeof el.className === "string" && el.className.trim() !== ""
      ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return el.tagName.toLowerCase() + cls;
  }
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }
  function lineOf(el) {
    return el.getAttribute !== undefined ? (el.getAttribute("data-line") || "") : "";
  }
  function applyEnhance() {
    const list = document.querySelectorAll("#doc .katex-display");
    for (let i = 0; i < list.length; i += 1) {
      const disp = list[i];
      const inner = disp.querySelector(".katex");
      if (inner === null) continue;
      inner.style.transform = "";
      disp.style.height = "";
      disp.removeAttribute("data-math-scale");
      inner.style.display = "inline-block";
      inner.style.width = "max-content";
      const natural = inner.getBoundingClientRect().width;
      inner.style.display = "";
      inner.style.width = "";
      const avail = disp.clientWidth;
      if (natural === 0 || avail === 0 || natural <= avail) continue;
      const scale = Math.max(MIN_SCALE, avail / natural);
      inner.style.transformOrigin = "center top";
      inner.style.transform = "scale(" + scale.toFixed(4) + ")";
      disp.style.height = Math.round(inner.offsetHeight * scale * 100) / 100 + "px";
      disp.setAttribute("data-math-scale", scale.toFixed(3));
    }
  }
  function setVariant(v) {
    const root = document.documentElement;
    root.setAttribute("data-theme", v.theme);
    root.style.setProperty("--fs-body", v.fs + "px");
    root.style.setProperty("--me-width", String(v.width));
    root.style.setProperty("--measure-wide", "calc((" + v.width + " + 14) * var(--fs-body))");
    const doc = document.getElementById("doc");
    if (v.cvOff) doc.classList.add("cv-off");
    else doc.classList.remove("cv-off");
  }
  function measure() {
    const doc = document.getElementById("doc");
    const content = document.getElementById("content");
    const dr = doc.getBoundingClientRect();
    const csDoc = getComputedStyle(doc);
    const innerRight = dr.right - parseFloat(csDoc.paddingRight || "0");
    const innerLeft = dr.left + parseFloat(csDoc.paddingLeft || "0");
    const out = {
      cvOff: doc.classList.contains("cv-off"),
      doc: { scrollW: doc.scrollWidth, clientW: doc.clientWidth, rect: rectOf(doc), innerRight },
      content: { scrollW: content.scrollWidth, clientW: content.clientWidth, scrollOverflow: content.scrollWidth > content.clientWidth + 1 },
      paperScrollOverflow: doc.scrollWidth > doc.clientWidth + 1,
      overflow: [], scrollable: [], tableWrap: [], katexDisplay: [], imgs: [], tokBreak: [], pre: [], mermaid: [],
      overlap: [], blocks: { total: 0, zeroHeight: 0, belowFold: 0 },
    };
    const BLOCK = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "TABLE", "IMG", "BLOCKQUOTE", "LI", "UL", "OL", "DIV", "FIGURE", "HR", "SECTION"]);
    const nodes = doc.querySelectorAll("*");
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      const overRight = Math.round((r.right - innerRight) * 100) / 100;
      const overLeft = Math.round((innerLeft - r.left) * 100) / 100;
      const inScroll = el.closest(".table-wrap, pre, .mermaid") !== null;
      const isBlockish = BLOCK.has(el.tagName) || el.classList.contains("katex") || el.classList.contains("katex-display") || el.classList.contains("math-fallback");
      if ((overRight > 1 || overLeft > 1) && cs.overflowX === "visible" && isBlockish && !inScroll) {
        out.overflow.push({ el: labelOf(el), line: lineOf(el), overRight, overLeft });
      }
      if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
        out.scrollable.push({ el: labelOf(el), line: lineOf(el), scrollW: el.scrollWidth, clientW: el.clientWidth, overflowX: cs.overflowX });
      }
    }
    for (const el of doc.querySelectorAll(".table-wrap")) {
      const r = el.getBoundingClientRect();
      out.tableWrap.push({ line: lineOf(el), scrollW: el.scrollWidth, clientW: el.clientWidth, scrollable: el.scrollWidth > el.clientWidth + 1, insidePaper: r.right <= innerRight + 1 && r.left >= innerLeft - 1 });
    }
    for (const el of doc.querySelectorAll(".katex-display")) {
      const r = el.getBoundingClientRect();
      out.katexDisplay.push({ line: lineOf(el), scale: el.getAttribute("data-math-scale"), clientW: el.clientWidth, scrollW: el.scrollWidth, insidePaper: r.right <= innerRight + 1 && r.left >= innerLeft - 1 });
    }
    for (const el of doc.querySelectorAll("img")) {
      const r = el.getBoundingClientRect();
      out.imgs.push({ src: el.getAttribute("src"), alt: el.getAttribute("alt"), complete: el.complete, naturalW: el.naturalWidth, naturalH: el.naturalHeight, w: Math.round(r.width), h: Math.round(r.height), broken: el.complete && el.naturalWidth === 0 });
    }
    for (const el of doc.querySelectorAll(".tok-break")) {
      const r = el.getBoundingClientRect();
      out.tokBreak.push({ text: (el.textContent || "").slice(0, 40), right: Math.round(r.right * 100) / 100, insidePaper: r.right <= innerRight + 1 });
    }
    for (const el of doc.querySelectorAll("pre")) {
      const r = el.getBoundingClientRect();
      out.pre.push({ line: lineOf(el), scrollW: el.scrollWidth, clientW: el.clientWidth, scrollable: el.scrollWidth > el.clientWidth + 1, insidePaper: r.right <= innerRight + 1 });
    }
    for (const el of doc.querySelectorAll(".mermaid")) {
      const r = el.getBoundingClientRect();
      out.mermaid.push({ line: lineOf(el), scrollW: el.scrollWidth, clientW: el.clientWidth, scrollable: el.scrollWidth > el.clientWidth + 1, insidePaper: r.right <= innerRight + 1, rendered: el.getAttribute("data-rendered") });
    }
    const kids = doc.children;
    out.blocks.total = kids.length;
    const vh = window.innerHeight;
    for (let i = 1; i < kids.length; i += 1) {
      const a = kids[i - 1];
      const b = kids[i];
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ov = Math.round((Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)) * 100) / 100;
      if (ov > 1) out.overlap.push({ a: labelOf(a), b: labelOf(b), overlapPx: ov });
    }
    for (let i = 0; i < kids.length; i += 1) {
      const rr = kids[i].getBoundingClientRect();
      if (rr.height === 0) out.blocks.zeroHeight += 1;
      if (rr.top > vh) out.blocks.belowFold += 1;
    }
    return out;
  }
  window.__audit = { applyEnhance, setVariant, measure, minScale: MIN_SCALE };
}

const VARIANTS = [];
for (const theme of ["light", "dark"]) for (const fs of [16, 24]) for (const width of [46, 80]) VARIANTS.push({ theme, fs, width });

function parseArgs(argv) {
  const o = { port: 9333, inDir: null, outDir: null, width: 1280, height: 900, limit: Infinity, quick: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") o.port = Number(argv[++i]);
    else if (a === "--in") o.inDir = argv[++i];
    else if (a === "--out") o.outDir = argv[++i];
    else if (a === "--viewport") { const p = argv[++i].split("x"); o.width = Number(p[0]); o.height = Number(p[1]); }
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--quick") o.quick = true;
  }
  return o;
}

function buildPage(fragment, cssBundle, minScale) {
  const base = "*{box-sizing:border-box}html,body{margin:0;padding:0}body{overflow:hidden}";
  return [
    "<!doctype html><html lang=\"zh-CN\" data-theme=\"light\"><head><meta charset=\"utf-8\">",
    "<style>" + base + "</style>",
    "<style>" + cssBundle + "</style>",
    "</head><body><div id=\"app\"><div class=\"body-row\"><main id=\"content\" class=\"content\">",
    "<article id=\"doc\" class=\"mdc\">", fragment, "</article></main></div></div>",
    "<script>(" + browserAudit.toString() + ")(" + JSON.stringify(minScale) + ");<" + "/script>",
    "</body></html>",
  ].join("");
}

async function waitReady(c, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await c.evaluate("document.readyState === 'complete' && (document.fonts === undefined || document.fonts.status === 'loaded')");
    if (ok === true) return;
    if (Date.now() > deadline) throw new Error("等待页面 readyState/fonts 超时");
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 先证 renderer 可用：browser 域能回 ≠ page 域能回。renderer 起不来时明确 exit 2，不写假数据。 */
async function probeRenderer(c, report, o) {
  let browserAlive = false;
  try { const v = await c.send("Browser.getVersion"); browserAlive = v !== null && typeof v.product === "string"; } catch { browserAlive = false; }
  let rendererOk = false;
  let probeErr = "";
  try { rendererOk = (await c.evaluate("1+1")) === 2; } catch (err) { probeErr = err.message; }
  if (rendererOk) { await c.enableDomains(); return true; }
  const msg = "CDP renderer 无响应（browserAlive=" + browserAlive + "）：page 目标 Browser.getVersion 能回、"
    + "Runtime.evaluate 超时；Chrome/Edge stderr 常见 `FATAL:mojo\\public\\cpp\\platform\\platform_channel.cc "
    + "Check failed: . : 拒绝访问。 (0x5)`（DLP/EDR 拦 Mojo 命名管道）。原始错误：" + probeErr;
  report.errors.push({ phase: "probe", browserAlive, message: msg });
  console.error("[visual-audit] " + msg);
  writeFileSync(join(o.outDir, "visual-report.json"), JSON.stringify(report, null, 2), "utf8");
  process.exitCode = 2;
  return false;
}
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.inDir === null || o.outDir === null) { console.error("用法: node visual-audit.mjs --in <html目录> --out <输出目录> [--port 9333] [--viewport 1280x900] [--limit N] [--quick]"); process.exit(1); }
  const minScale = readMathMinScale();
  const cssBundle = readCssBundle();
  const fixtures = readdirSync(o.inDir).filter((f) => f.endsWith(".html") && !f.startsWith("_")).sort().slice(0, o.limit);
  if (fixtures.length === 0) { console.error("输入目录没有 *.html：" + o.inDir); process.exit(1); }
  const pagesDir = join(o.outDir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  const pageOf = new Map();
  for (const f of fixtures) {
    const frag = readFileSync(join(o.inDir, f), "utf8");
    const pagePath = join(pagesDir, f);
    writeFileSync(pagePath, buildPage(frag, cssBundle, minScale), "utf8");
    pageOf.set(f, pathToFileURL(pagePath).href);
  }
  const report = { generatedAt: new Date().toISOString(), tool: "tests/tools/visual-audit.mjs", viewport: { width: o.width, height: o.height }, mathMinScale: minScale, note: "几何全部来自 getBoundingClientRect/scrollWidth/clientWidth/naturalWidth；overlap=相邻块矩形相交 px", fixtures: [], errors: [] };

  const c = await connectToPage({ port: o.port });
  try {
    if (!(await probeRenderer(c, report, o))) return;
    try {
      await c.evaluate("navigator.userAgent");
    } catch (err) {
      const msg = "CDP page 目标无响应（renderer 未启动）。check: Browser.getVersion 能回、Runtime.evaluate 超时；"
        + "Chrome/Edge stderr 常见 `FATAL:mojo\\public\\cpp\\platform\\platform_channel.cc Check failed: . : 拒绝访问。 (0x5)`"
        + "（DLP/EDR 拦 Mojo 命名管道）。原始错误：" + err.message;
      report.errors.push({ phase: "probe", message: msg });
      console.error("[visual-audit] " + msg);
      writeFileSync(join(o.outDir, "visual-report.json"), JSON.stringify(report, null, 2), "utf8");
      process.exitCode = 2;
      return;
    }
    await c.send("Emulation.setDeviceMetricsOverride", { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
    const variants = o.quick ? [VARIANTS[0]] : VARIANTS;
    for (const f of fixtures) {
      const entry = { file: f, page: pageOf.get(f), variants: [] };
      try {
        await c.send("Page.navigate", { url: pageOf.get(f) });
        await waitReady(c, 15000);
        for (const v of variants) {
          for (const cvOff of [false, true]) {
            await c.evaluate("window.__audit.setVariant(" + JSON.stringify({ theme: v.theme, fs: v.fs, width: v.width, cvOff }) + "); window.__audit.applyEnhance();");
            await c.evaluate("new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r);});})");
            const m = await c.evaluate("window.__audit.measure()");
            m.variant = { theme: v.theme, fs: v.fs, width: v.width, cvOff };
            entry.variants.push(m);
          }
        }
      } catch (err) {
        entry.error = err.message;
        report.errors.push({ phase: "fixture", file: f, message: err.message });
      }
      report.fixtures.push(entry);
      console.log("[visual-audit] " + f + " variants=" + entry.variants.length + (entry.error === undefined ? "" : " ERROR=" + entry.error));
    }
  } finally {
    c.close();
  }
  writeFileSync(join(o.outDir, "visual-report.json"), JSON.stringify(report, null, 2), "utf8");
  const bad = [];
  for (const fx of report.fixtures) for (const v of fx.variants) {
    if (v.paperScrollOverflow || v.content.scrollOverflow) bad.push(fx.file + " " + v.variant.theme + "/" + v.variant.fs + "px/" + v.variant.width + "em" + (v.variant.cvOff ? "/cv-off" : "/cv-on") + " paperScroll=" + v.paperScrollOverflow + " contentScroll=" + v.content.scrollOverflow);
    if (v.overflow.length > 0) bad.push(fx.file + " overflow=" + JSON.stringify(v.overflow));
    if (v.overlap.length > 0) bad.push(fx.file + " overlap=" + JSON.stringify(v.overlap));
  }
  console.log("[visual-audit] fixtures=" + report.fixtures.length + " badFindings=" + bad.length + " -> " + join(o.outDir, "visual-report.json"));
  for (const b of bad.slice(0, 40)) console.log("  ! " + b);
}

main().catch((e) => { console.error("[visual-audit] fatal: " + (e && e.stack ? e.stack : e)); process.exit(1); });