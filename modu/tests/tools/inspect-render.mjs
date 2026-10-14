import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
const outDir = process.argv[2];
const files = readdirSync(outDir).filter((f) => f.endsWith(".html") && !f.startsWith("_")).sort();
for (const f of files) {
  const dom = new JSDOM(readFileSync(join(outDir, f), "utf8"));
  const d = dom.window.document;
  const q = (s) => d.querySelectorAll(s).length;
  const links = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  const imgs = [...d.querySelectorAll("img")].map((i) => i.getAttribute("src"));
  const alerts = [...d.querySelectorAll("[data-alert]")].map((e) => e.getAttribute("data-alert"));
  const pre = [...d.querySelectorAll("pre")].map((p) => JSON.stringify((p.textContent||"").slice(0,60)));
  const tokText = [...d.querySelectorAll(".tok-break")].map((e) => e.textContent);
  console.log(`${f.replace(/\.html$/,"")}: gaps=${q(".cjk-gap")} toks=${q(".tok-break")}${tokText.length?"["+tokText.join(",")+"]":""} katex=${q(".katex")}(disp ${q(".katex-display")}) fb=${q(".math-fallback")} math=${q("math")} sem=${q("semantics")} ann=${q("annotation")} hljs=${q("code.hljs")} alerts=[${alerts.join(",")}] links=${JSON.stringify(links)} imgs=${JSON.stringify(imgs)} pre=${pre.join(";")}`);
}