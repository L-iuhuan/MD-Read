/**
 * 带门禁的提交器（2026-09-23 · 批次3 事故后的机制化修正）
 *
 * 存在理由：本项目**连续三次**栽在同一个机制缺口上 —— "先写/先推后验"：
 *   ① 非法 JSON 那次（改完没 `JSON.parse` 就推）
 *   ② "逐字节相同"先写进提交信息后证那次
 *   ③ 报告入仓**带着敏感命中**那次（门禁 EXIT=1，脚本只打印、人没看，照样 commit+push）
 * ⇒ **缺的是机制，不是提醒** ✓ 所以把"门禁"放进**提交的前置条件**里，让人没有机会跳过。
 *
 * 用法：
 *   node modu/tests/tools/commit-with-gates.mjs --msg <消息文件> [--full] -- <显式路径…>
 *     --msg   必填，`git commit -F` 用的消息文件（UTF-8 无 BOM）
 *     --full  额外跑一次 `pnpm run check:full`（= check + vite build；CSS 压缩级缺陷只有它能抓）
 *   退出码：0 = 已提交；1 = 门禁未过（**不提交**）；2 = 参数错
 *
 * 纪律（写在这里，不靠自觉）：
 *   · 门禁 EXIT ≠ 0 ⇒ **直接 exit 1，什么都不提交** ✓
 *   · "命中已清"以 **EXIT 码**判定，不接受"报告里说明了它是假的"当豁免 ✗
 *   · 脱敏/修完必须**重跑到绿**再推 ✓
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const msgAt = argv.indexOf("--msg");
const sepAt = argv.indexOf("--");
const full = argv.includes("--full");
if (msgAt === -1 || argv[msgAt + 1] === undefined || sepAt === -1) {
  console.error("用法：node modu/tests/tools/commit-with-gates.mjs --msg <消息文件> [--full] -- <显式路径…>");
  process.exit(2);
}
const msgFile = argv[msgAt + 1];
const paths = argv.slice(sepAt + 1).filter((p) => p !== "--full" && p !== "--msg" && p !== msgFile);
if (!existsSync(msgFile)) { console.error(`消息文件不存在：${msgFile}`); process.exit(2); }
if (paths.length === 0) { console.error("必须给「显式路径」（不许裸 `git add -A`）"); process.exit(2); }
// 消息文件不能带 BOM（git 会把它写进提交信息）
if (readFileSync(msgFile)[0] === 0xef && readFileSync(msgFile)[1] === 0xbb) {
  console.error("消息文件带 BOM ⇒ 先用 UTF8Encoding($false) 重写"); process.exit(2);
}

/**
 * ⚠ **不用 `shell: true`**（那是隐患，不是风格问题）：`shell:true` 会把参数**拼接成命令行** ⇒
 *   路径/消息里出现 cmd 元字符（`&` `|` `^` `>`）就会走样 ✗ —— 而**文件名带 `&` 是合法的**，
 *   本仓库文件名还常带中文/空格/圆括号 ⇒ 必须 **参数数组 + shell:false** ✓（Node 也会报 DEP0190 警告 ✓）
 */
function run(exe, args, cwd) {
  const r = spawnSync(exe, args, { cwd, shell: false, encoding: "utf8" });
  // ⚠ spawn 失败时 r.error 有值、stdout/stderr 可能是 null ⇒ 必须显式报出来（否则就是"沉默" ✗）
  if (r.error !== undefined && r.error !== null) return { code: 1, out: `spawn 失败（${exe}）：${r.error.message}` };
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
/** Windows 上 `.cmd`/`.bat`（含 `pnpm` 这类 .cmd shim）不能直接 exec ⇒ 显式经 `cmd.exe /c` 调用；
 *  命令串是**脚本内固定字面量**（不含任何外部输入）⇒ 无拼接风险 ✓ */
function runCmd(commandLine, cwd) {
  const comspec = process.env.ComSpec ?? "cmd.exe";
  return run(comspec, ["/c", commandLine], cwd);
}

/** ⚠ Windows：`CreateProcess` 不按 PATHEXT 解析裸名字 ⇒ `spawnSync("git", …, {shell:false})` 会**失败且无输出** ✗
 *  （本脚本曾因此报 `git add 失败：` 后面**空无一字**）⇒ 显式给 `git.exe` ✓ */
const GIT = process.platform === "win32" ? "git.exe" : "git";
const root = process.cwd();
console.log(`[gates] add ${paths.length} 个路径…`);
const add = run(GIT, ["add", ...paths], root);
if (add.code !== 0) { console.error(`[gates] git add 失败：\n${add.out}`); process.exit(1); }

console.log("[gates] 1/2 敏感信息门禁…");
const sensitive = runCmd("scripts\\check-sensitive.cmd", root);
console.log(sensitive.out.split(/\r?\n/).slice(-3).join("\n"));
if (sensitive.code !== 0) {
  console.error(`[gates] ✗ 敏感门禁未过（EXIT=${sensitive.code}）⇒ **不提交**（请脱敏后重跑到 0）`);
  process.exit(1);
}

if (full) {
  console.log("[gates] 2/2 check:full（tsc ×2 + eslint + vitest + vite build）…");
  const cf = runCmd("pnpm run check:full", `${root}/modu`);
  console.log(cf.out.split(/\r?\n/).slice(-6).join("\n"));
  if (cf.code !== 0) { console.error(`[gates] ✗ check:full 未过（EXIT=${cf.code}）⇒ **不提交**`); process.exit(1); }
} else {
  console.log("[gates] 2/2 check:full 已跳过（未给 --full）");
}

console.log("[gates] 门禁全绿 ⇒ 提交");
const commit = run(GIT, ["commit", "-F", msgFile], root);
console.log(commit.out);
if (commit.code !== 0) { console.error("[gates] git commit 失败"); process.exit(1); }
const head = run(GIT, ["rev-parse", "HEAD"], root);
console.log(`[gates] ✓ 已提交 ${head.out.slice(0, 7)}（工作树 ${run(GIT, ["status", "--porcelain"], root).out.split(/\r?\n/).filter(Boolean).length} 项）`);
