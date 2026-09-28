#!/usr/bin/env node
/**
 * 换机自检（一条命令版）—— 把《换机交付与验收报告》里那 13 条清单里**能自动化**的部分固化。
 *
 * 目的：把"换到另一台电脑能不能用"从**一整天排障**降成**跑一行、看结论** ✓
 *   node modu/tests/tools/check-portability.mjs [--bundle <bundle目录>] [--json]
 *
 * 设计纪律（与项目 AGENTS 同款）：
 * · 每条判据都必须**决定性**：不许出现"系统里有 msedgewebview2 就算有运行时"这种恒真检查 ✗
 * · 拿不到读数 ⇒ 报 **WARN（未覆盖）**，**不算通过** ✓（"看不见"与"不存在"必须可区分 ✗）
 * · 无机器绝对路径：一切默认值从**本文件位置**推导 ✓
 * · 只读：不改注册表、不写 profile、不启动应用 ✓（唯一例外是读文件）
 */
import { existsSync, readFileSync, readdirSync, statSync, accessSync, constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const HERE = path.resolve(import.meta.dirname ?? ".");
const REPO = path.resolve(HERE, "..", "..", ".."); // modu/tests/tools → 仓库根
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const JSON_OUT = argv.includes("--json");
const BUNDLE = argOf("--bundle", path.join(REPO, "modu", "src-tauri", "target", "release", "bundle"));

const results = [];
const add = (level, title, detail) => results.push({ level, title, detail });

/** 跑一条只读命令；拿不到读数返回 null（⇒ 上层报 WARN，不当成通过 ✗） */
function tryRun(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 20000 });
  } catch {
    return null;
  }
}

/* ---------- ① 操作系统 ---------- */
{
  // ⚠ 不用 `cmd /c ver`：它的输出是 OEM 代码页，Node 按 UTF-8 解会乱码 ✗（本批实测）
  const rel = os.release();
  const ver = typeof os.version === "function" ? os.version() : "";
  if (!rel) {
    add("WARN", "操作系统版本", "拿不到读数 —— 无法判定，**不算通过**");
  } else {
    add("PASS", "操作系统版本", `${rel}${ver ? ` · ${ver}` : ""}（${process.platform} ${process.arch}）`);
  }
}

/* ---------- ② WebView2 运行时（装包/运行的前置；缺失时应用起不来） ---------- */
{
  // 官方 Evergreen 运行时在注册表里的固定 GUID；HKLM 与 HKCU 两处都查（每用户安装也存在）
  const guid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
  const keys = [
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
    `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
    `HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${guid}`,
  ];
  let found = null;
  for (const key of keys) {
    const out = tryRun("reg", ["query", key, "/v", "pv"]);
    if (out !== null && /pv\s+REG_SZ\s+\S+/.test(out)) {
      found = out.match(/pv\s+REG_SZ\s+(\S+)/)?.[1] ?? "（有键但读不到版本）";
      break;
    }
  }
  if (found === null) {
    add("FAIL", "WebView2 运行时", "注册表里查不到 Evergreen 运行时 ⇒ 应用**起不来**；装 NSIS 包时会联网自动补装，或手动装 MicrosoftEdgeWebview2Setup.exe");
  } else {
    add("PASS", "WebView2 运行时", `Evergreen pv = ${found}`);
  }
}

/* ---------- ③ 用户数据目录可写（WebView2 profile 要建在这里） ---------- */
{
  const base = process.env.LOCALAPPDATA;
  if (!base) {
    add("FAIL", "用户数据目录", "%LOCALAPPDATA% 不存在 ⇒ 无法建 profile，应用起不来");
  } else {
    try {
      accessSync(base, constants.W_OK);
      add("PASS", "用户数据目录", `${base} 可写`);
    } catch {
      add("FAIL", "用户数据目录", `${base} **不可写** ⇒ profile 建不起来（重定向到只读/网络位置时常见）`);
    }
  }
}

/* ---------- ④ 安装包产物 + 体积门禁 ---------- */
{
  const msi = path.join(BUNDLE, "msi");
  const nsis = path.join(BUNDLE, "nsis");
  const pick = (dir, ext) => {
    if (!existsSync(dir)) {
      return null;
    }
    const f = readdirSafe(dir).find((n) => n.toLowerCase().endsWith(ext));
    return f ? path.join(dir, f) : null;
  };
  const nsisExe = pick(nsis, ".exe");
  const msiFile = pick(msi, ".msi");
  if (nsisExe === null && msiFile === null) {
    add("WARN", "安装包产物", `${BUNDLE} 下没有 msi/nsis ⇒ 先跑 \`pnpm tauri build\`（**未覆盖**，不算通过）`);
  } else {
    for (const f of [nsisExe, msiFile].filter(Boolean)) {
      const mb = statSync(f).size / 1048576;
      const isMsi = f.toLowerCase().endsWith(".msi");
      add(isMsi && mb > 8 ? "FAIL" : "PASS", `产物 ${path.basename(f)}`, `${mb.toFixed(2)} MB${isMsi ? "（msi 硬门禁 ≤8MB）" : "（NSIS · per-user 免管理员 ✓）"}`);
    }
  }
}

/* ---------- ⑤ ⭐ 发行物不许依赖未随包发布的 DLL（历史上真踩过 ✗） ---------- */
{
  const exe = path.join(REPO, "modu", "src-tauri", "target", "release", "modu.exe");
  if (!existsSync(exe)) {
    add("WARN", "exe 外部依赖", "release/modu.exe 不存在（未构建）—— **未覆盖**，不算通过");
  } else {
    const buf = readFileSync(exe);
    const hit = buf.includes(Buffer.from("WebView2Loader.dll", "ascii"));
    add(
      hit ? "FAIL" : "PASS",
      "exe 外部依赖",
      hit
        ? "❌ 导入表里出现 WebView2Loader.dll ⇒ **换台机器极可能起不来**（该 DLL 不随包发布）"
        : "✅ 不含 WebView2Loader.dll ⇒ 加载器是静态链接的（换机风险已根除）",
    );
    // 同一判据也扫安装包（它们内嵌同一个 exe）
    for (const f of [path.join(BUNDLE, "nsis"), path.join(BUNDLE, "msi")]) {
      if (!existsSync(f)) {
        continue;
      }
      for (const n of readdirSafe(f)) {
        const p = path.join(f, n);
        if (!/\.(exe|msi)$/i.test(n)) {
          continue;
        }
        const bad = readFileSync(p).includes(Buffer.from("WebView2Loader.dll", "ascii"));
        add(bad ? "FAIL" : "PASS", `产物 ${n} 的外部依赖`, bad ? "含 WebView2Loader.dll ⇒ 换机有风险" : "不含外部加载器依赖 ✓");
      }
    }
  }
}

/* ---------- ⑥ .md 关联状态（⚠ 本机可能有"排障期写入的影子" ✗） ---------- */
{
  const q = (key, name) => {
    const out = tryRun("reg", ["query", key, "/ve"]);
    if (out === null) {
      return null;
    }
    const m = out.match(new RegExp(`${name}\\s+REG_SZ\\s+(.*)`, "i")) ?? out.match(/REG_SZ\s+(.*)/);
    return m ? m[1].trim() : "";
  };
  // ⚠ 只报"默认值是什么"不够：本机排障期写过一条指向 per-user 副本的**影子** ✗，
  //   它与"用户自己选的关联"在注册表里长得一样 ⇒ 必须补一路判据：**目标 exe 是否存在** ✓
  const mdDefault = q("HKCU\\Software\\Classes\\.md", "(Default)") ?? q("HKCU\\Software\\Classes\\.md", "默认");
  const cmd = (() => {
    const out = tryRun("reg", ["query", "HKCU\\Software\\Classes\\MoDu.md\\shell\\open\\command", "/ve"]);
    return out === null ? null : (out.match(/REG_SZ\s+(.*)/)?.[1] ?? "").trim();
  })();
  if (mdDefault === null) {
    add("WARN", ".md 关联", "读不到 HKCU\\Software\\Classes\\.md（未覆盖）");
  } else if (mdDefault === "") {
    add("PASS", ".md 关联", "未设置（新机常态 ✓）—— 需在应用内点「设为 .md 默认应用」再在系统默认应用页选一次");
  } else {
    const exePath = cmd ? (cmd.match(/"([^"]+\.exe)"/i)?.[1] ?? "") : "";
    const exeOk = exePath === "" ? null : existsSync(exePath);
    add(
      exeOk === false ? "FAIL" : "PASS",
      ".md 关联",
      `.md 默认值 = ${mdDefault}${cmd ? ` · open 命令 = ${cmd}` : ""}` +
        (exeOk === false
          ? " ⇒ ❌ **目标 exe 不存在**（关联是坏的，双击会报错）"
          : exeOk === true
            ? " ⇒ 目标 exe 存在 ✓（⚠ 但仍无法区分「用户选的」与「排障期写的影子」——新机首次运行需手动选一次 ✓）"
            : ""),
    );
  }
}

/* ---------- ⑦ 单实例：有没有"无主窗口的僵尸"攥着锁 ✗ ---------- */
{
  const out = tryRun("tasklist", ["/FI", "IMAGENAME eq modu.exe", "/FO", "CSV", "/NH"]);
  if (out === null) {
    add("WARN", "运行中的实例", "tasklist 读不到（未覆盖）");
  } else if (/modu\.exe/i.test(out)) {
    add("WARN", "运行中的实例", `已有 modu.exe 在跑：${out.trim().split(/\r?\n/)[0]} —— 后启动的会被单实例转发；若窗口没出现，先查是不是僵尸攥锁（看门狗已能识别并退出 ✓）`);
  } else {
    add("PASS", "运行中的实例", "干净（无 modu.exe）");
  }
}

/* ---------- ⑧ 报告 ---------- */
function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const icon = { PASS: "✅", FAIL: "❌", WARN: "⚠️ " };
if (JSON_OUT) {
  console.log(JSON.stringify({ repo: REPO, bundle: BUNDLE, results }, null, 2));
} else {
  console.log("墨读 · 换机自检（只读，不改机器状态 ✓）");
  console.log(`  仓库 = ${REPO}`);
  console.log(`  产物目录 = ${BUNDLE}`);
  console.log("");
  for (const r of results) {
    console.log(`${icon[r.level] ?? "?"} ${r.title}：${r.detail}`);
  }
  const fail = results.filter((r) => r.level === "FAIL").length;
  const warn = results.filter((r) => r.level === "WARN").length;
  console.log("");
  console.log(`结论：${results.length - fail - warn} 通过 · ${fail} 失败 · ${warn} 未覆盖`);
  console.log(
    fail > 0
      ? "⇒ 有 FAIL：**这台机器上装/跑墨读会出问题**，先修上面 ❌ 那几条 ✓"
      : warn > 0
        ? "⇒ 没有 FAIL；⚠️ 是「没读到」而不是「没问题」，别当成通过 ✓"
        : "⇒ 全部通过 ✓ 可以往下走：双击 NSIS 安装 → 启动一次 → 设置里设为 .md 默认应用 ✓",
  );
}
process.exit(results.some((r) => r.level === "FAIL") ? 1 : 0);
