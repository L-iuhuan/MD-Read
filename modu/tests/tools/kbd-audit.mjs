/**
 * 键盘可达性审计（2026-09-27 阶段④-④）。
 *
 * 为什么需要它：静态审计（`:focus-visible` 兜底 / 有没有 click 挂在非按钮上 / tabindex）只能证明
 * "**应该**能用键盘" ✗ —— 真问题是"**真按 Tab 能不能走完**" ✓。本工具用 CDP 派发**真实按键** ✓，
 * 逐次记录 `document.activeElement`、焦点环（computed `outline-*`）、是否可见，最后验 Esc 收浮层 ✓。
 *
 * 用法：起带 CDP 的应用后 `node modu/tests/tools/kbd-audit.mjs [--port 9222] [--steps 22]`
 * 判据：**无焦点环 0 个** · **焦点落在不可见元素 0 个** · Esc 能收起浮层 ✓
 *   （Tab 循环里出现一次 BODY = 浏览器正常回绕 ✓，不是缺陷 ✗）
 */import { connectToPage } from "../tools/cdp.mjs";
const c = await connectToPage({ port: 9222 });
await c.enableDomains();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const describe = () => c.evaluate(`JSON.stringify((() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: "BODY", id: null, text: null, ring: null, visible: null };
  const cs = getComputedStyle(el);
  const b = el.getBoundingClientRect();
  return { tag: el.tagName.toLowerCase(), id: el.id || null,
           text: (el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").slice(0, 22),
           ring: cs.outlineStyle + " " + cs.outlineWidth,
           visible: b.width > 0 && b.height > 0 };
})())`).then(JSON.parse);

// 焦点从 body 开始（真实起点 ✓）
await c.evaluate(`document.activeElement?.blur(); document.body.focus();`);
const seq = [];
for (let i = 0; i < 22; i++) {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" });
  await sleep(90);
  seq.push(await describe());
}
// Esc 行为：打开设置面板 → Esc → 看是否收起
await c.evaluate(`document.getElementById('settings-panel').hidden = false`);
await sleep(300);
await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
await c.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" });
await sleep(400);
const panelAfterEsc = JSON.parse(await c.evaluate(`JSON.stringify(document.getElementById('settings-panel').hidden)`));

console.log("Tab 焦点序列（22 次）：");
seq.forEach((s, i) => console.log(`  ${String(i + 1).padStart(2)}. ${s.tag}${s.id ? "#" + s.id : ""} ${s.ring === "none 0px" ? "❌无焦点环" : "✓" + s.ring} ${s.visible ? "" : "❌不可见"} «${s.text ?? ""}»`));
console.log("Esc 后设置面板 hidden = " + panelAfterEsc + (panelAfterEsc ? " ✓（Esc 能收起浮层）" : " ✗（Esc 没收起）"));
// 统计
const noRing = seq.filter((s) => s.tag !== "BODY" && s.ring === "none 0px").length;
const invisible = seq.filter((s) => s.tag !== "BODY" && s.visible === false).length;
const bodyCount = seq.filter((s) => s.tag === "BODY").length;
console.log(`结论：无焦点环 ${noRing} 个 · 焦点落在不可见元素 ${invisible} 个 · Tab 掉出到 BODY ${bodyCount} 次`);
await c.close();
