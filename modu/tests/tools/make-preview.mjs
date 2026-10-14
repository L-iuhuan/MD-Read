/**
 * 把渲染探针的**逐用例 HTML 片段**组装成一份可以在普通浏览器里看的预览页：
 * 用**应用真实 DOM 结构** `<main class="content"><article id="doc" class="mdc cv-off">`，
 * 并挂上应用真实样式表（tokens/cjk/hljs/katex/print/app）⇒ 纸面、限宽、公式排版都与墨读内一致。
 *
 * ⚠ 两个坑（2026-10-14 实修）：
 *  1. 探针的 `_report.html` **没有 `<head>`**，直接注入 `<link>` 会静默失败（第一版挂不上样式）；
 *     所以这里改为**自己组装整页**，只用逐用例的 HTML 片段。
 *  2. `cjk.css` 的 `@media screen { .mdc > * { content-visibility: auto } }` 会把视口外的块
 *     先跳过 ⇒ 静态长页会出现「中间一片空白」。用应用自带的开关类 `.cv-off` 关掉它
 *     （就是 offscreen-policy.ts 在块数过多时用的那一手）。
 *
 * 用法（在**仓库根**执行）：
 *   node modu/tests/tools/make-preview.mjs --in <.verify/…/outDir> --src <.verify/…/mdDir> --out <目标.html>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1];
}
const inDir = resolve(args.in);
const srcDir = resolve(args.src);
const outFile = resolve(args.out);
const outDir = dirname(outFile);

const css = [
  "modu/node_modules/katex/dist/katex.min.css",
  "modu/src/typography/tokens.css",
  "modu/src/typography/cjk.css",
  "modu/src/typography/hljs.css",
  "modu/src/typography/print.css",
  "modu/src/app.css",
].map((p) => {
  const rel = relative(outDir, resolve(p)).split("\\").join("/");
  return `<link rel="stylesheet" href="${rel}">`;
});

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
const names = readdirSync(inDir).filter((f) => f.endsWith(".html") && !f.startsWith("_")).sort();

const sections = names.map((f, i) => {
  const name = f.replace(/\.html$/, "");
  const frag = readFileSync(join(inDir, f), "utf8");
  let src = "";
  try { src = readFileSync(join(srcDir, name + ".md"), "utf8").replace(/\r\n/g, "\n"); } catch { src = "（源码未找到）"; }
  return [
    `<section class="case">`,
    `<h2>${String(i + 1).padStart(2, "0")} · ${esc(name)}</h2>`,
    `<details><summary>看源码（点开/收起）</summary><pre class="src">${esc(src)}</pre></details>`,
    `<main class="content"><article id="doc" class="mdc cv-off">`,
    frag,
    `</article></main>`,
    `</section>`,
  ].join("\n");
});

const html = [
  `<!doctype html><html lang="zh-CN" data-theme="light" data-palette="dianlan">`,
  `<head><meta charset="utf-8"><title>墨读 · 渲染结果预览</title>`,
  ...css,
  `<style>`,
  `  html, body { margin: 0; }`,
  `  body { background: #f4f5f7; font-family: system-ui, sans-serif; padding: 0 0 4em; }`,
  `  .top { max-inline-size: 1100px; margin: 0 auto; padding: 20px 16px 0; }`,
  `  .top h1 { font-size: 18px; margin: 0 0 6px; }`,
  `  .top p { font-size: 13px; line-height: 1.7; color: #444; margin: 0; }`,
  `  .case { max-inline-size: 1100px; margin: 18px auto; background: #fff; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }`,
  `  .case > h2 { font-size: 13px; margin: 0; padding: 8px 12px; background: #eef2f7; border-bottom: 1px solid #ddd; }`,
  `  .case > details { margin: 0; }`,
  `  .case > details > summary { font-size: 12px; padding: 6px 12px; cursor: pointer; color: #567; }`,
  `  pre.src { margin: 0; padding: 10px 12px; background: #fafbfc; border-bottom: 1px solid #e5e7eb;`,
  `            white-space: pre-wrap; font-size: 12px; line-height: 1.55; color: #333; max-block-size: 40vh; overflow: auto; }`,
  `  /* app.css 把 body 锁成 overflow:hidden（应用里滚动交给定高的 #content）；静态页没有那套结构， */`,
  `  /* 所以这里必须把滚动还给页面，并让 .content 按内容自然长高（2026-10-14 用户反馈「HTML 无法滚动」）。 */`,
  `  html, body { overflow: auto; block-size: auto; }`,
  `  .content { overflow: visible; block-size: auto; }`,
  `  .content > #doc { min-block-size: 0; }`,
  `  .content { background: #fff; }`,
  `</style>`,
  `</head><body>`,
  `<div class="top"><h1>墨读 · 渲染结果预览（2026-10-13 修复批次）</h1>`,
  `<p>下面每个用例：先折叠着放**源码**，下面就是**墨读阅读态会渲染成的样子**（用的是同一套样式表与同一份 DOM）。` +
    `外观对照语料里每节的「✅ 对了 / ❌ 坏了」。⚠ 编辑态（Live Preview）与顶栏/大纲不在这里，必须用墨读本体看。</p></div>`,
  ...sections,
  `</body></html>`,
].join("\n");

writeFileSync(outFile, html, "utf8");
console.log("预览页已生成：" + outFile + "（" + names.length + " 个用例）");