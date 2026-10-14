/**
 * 临时探针（审查用，非入库）：把 PROBE_IN 目录下每个 *.md 走完整渲染管线，
 * 落盘 HTML / 纯文本 / outline 与一份总览报告，供浏览器几何检查与人工比对。
 */
import { it } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDocument } from "../../src/render/pipeline";

const inDir = process.env.PROBE_IN;
const outDir = process.env.PROBE_OUT;

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] ?? c));
}

// 未设 env 时自动跳过：本文件是审查期探针（跑法见 .verify/audit/reports/lead-math.md），
// 不能让 `pnpm run check` 因为「没给 PROBE_IN」而红。
it.skipIf(inDir === undefined || outDir === undefined)("probe: render corpus dir", () => {
  mkdirSync(outDir as string, { recursive: true });
  const files = readdirSync(inDir as string).filter((f) => f.endsWith(".md")).sort();
  const parts: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(inDir as string, f), "utf8").replace(/\r\n/g, "\n");
    const { html, outline } = renderDocument(src);
    const name = f.replace(/\.md$/, "");
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    writeFileSync(join(outDir as string, name + ".html"), html, "utf8");
    writeFileSync(join(outDir as string, name + ".txt"), text, "utf8");
    writeFileSync(join(outDir as string, name + ".outline.json"), JSON.stringify(outline, null, 2), "utf8");
    parts.push(
      `<section><h2>${esc(name)}</h2><pre class="src">${esc(src)}</pre><div class="md-host"><div class="mdc">${html}</div></div></section>`,
    );
  }
  writeFileSync(
    join(outDir as string, "_report.html"),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>probe</title>` +
      `<style>body{font-family:system-ui;margin:0;padding:16px;background:#f5f5f5}` +
      `.src{background:#fff;border:1px solid #ccc;padding:8px;white-space:pre-wrap;font-size:12px}` +
      `section{background:#fff;margin:12px 0;padding:12px;border:1px solid #ddd}` +
      `.md-host{border-top:2px solid #08f;padding-top:8px}` +
      `h2{font-size:14px;color:#08f}</style>` +
      `<body>${parts.join("")}</body></html>`,
    "utf8",
  );
  writeFileSync(join(outDir as string, "_index.json"), JSON.stringify(files, null, 2), "utf8");
});