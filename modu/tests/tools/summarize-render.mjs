import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const outDir = process.argv[2];
const files = readdirSync(outDir).filter((f) => f.endsWith(".html") && !f.startsWith("_"));

function shape(el, depth, lines) {
  const tag = el.tagName.toLowerCase();
  const cls = el.className ? "." + String(el.className).split(/\s+/).join(".") : "";
  const attrs = ["data-line", "id", "href", "src", "title", "data-lang", "align", "style", "data-alert", "checked", "type", "disabled"]
    .filter((a) => el.hasAttribute(a))
    .map((a) => ` ${a}=${JSON.stringify(el.getAttribute(a))}`)
    .join("");
  const kids = [...el.children];
  const inlineKids = kids.filter((k) => /^(strong|em|s|code|a|img|br|input|span|kbd|sub|sup|mark|del|ins)$/.test(k.tagName.toLowerCase()));
  const blockKids = kids.filter((k) => !inlineKids.includes(k));
  let line = "  ".repeat(depth) + "<" + tag + cls + attrs + ">";
  const text = el.textContent ?? "";
  if (blockKids.length === 0 && text.length > 0) line += "  :: " + JSON.stringify(text.slice(0, 90));
  else line += `  (${inlineKids.length} inline)`;
  lines.push(line);
  for (const k of blockKids) shape(k, depth + 1, lines);
}
for (const f of files.sort()) {
  const dom = new JSDOM(readFileSync(join(outDir, f), "utf8"));
  const body = dom.window.document.body;
  const lines = [];
  for (const child of body.children) shape(child, 0, lines);
  const text = body.textContent ?? "";
  const leaks = ["**", "$$", "\\[", "\\(", "```", "~~", "[!NOTE]", "[^"].filter((m) => text.includes(m));
  console.log(`\n### ${f.replace(/\.html$/, "")}${leaks.length ? "  ⚠literal:" + leaks.join("|") : ""}`);
  console.log(lines.join("\n"));
}