/**
 * 错误文案的**系统性**锚（2026-09-27 阶段④-②）。
 *
 * 为什么需要它：项目铁律写着「错误信息中文、面向使用者，不露技术黑话」✓，
 * 但一直是**靠人看**的 ✗ —— 本批一次枚举就抓到三处漏网：
 *   · `showError` 用 `String(error)` ⇒ JS Error 变成「Error: 具体消息」，
 *     状态栏（面向使用者的通道）多一个英文前缀 ✗
 *   · `throw new Error("界面元素缺失：#set-font")` ⇒ 内部 id 上屏 ✗
 *   · `format!("打印引擎返回错误：hr={errorcode:?}")` ⇒ HRESULT 上屏 ✗
 * ⇒ 把「不许露黑话」变成**可执行的扫描** ✓：命中就红，以后新加文案自动被拦 ✓
 *
 * ⚠ 范围只说**面向用户**的 throw 文案；`console.error` / `eprintln!` **不在范围** ✓
 *   （铁律 A4：技术细节**只进 console**，使用者只看下一行 ✓）
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** 递归收集 src 下的 .ts（排除 .d.ts） */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...tsFiles(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** 取出 `throw new Error("…")` 里的文案 */
function thrownMessages(source: string): string[] {
  return [...source.matchAll(/throw new Error\(\s*"([^"]*)"/g)].map((m) => m[1]);
}

describe("面向用户的错误文案不许露技术黑话（系统性扫描）", () => {
  const files = tsFiles("src");
  const msgs = files.flatMap((f) => thrownMessages(readFileSync(f, "utf8")));

  it("扫描器自证：确实扫到了文案（空集合会让本锚恒真 ✗）", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(msgs.length).toBeGreaterThanOrEqual(8);
  });

  it("文案里不出现内部 id / 选择器 / 字段名等符号", () => {
    // 判据：`#id`、`.class`、`snake_case`、`--css-var`、全大写常量（"请重启墨读"那类不受影响 ✓）
    const bad = msgs.filter(
      (m) => /#[A-Za-z]|\.[a-z][A-Za-z-]*\b|_|--[a-z]|[A-Z]{3,}/.test(m) && !/请重启墨读|请重试/.test(m),
    );
    expect(bad, `这些错误文案露了内部符号：\n${bad.join("\n")}`).toEqual([]);
  });

  it("文案都带中文（不是英文技术串）", () => {
    const english = msgs.filter((m) => !/[\u4e00-\u9fa5]/.test(m));
    expect(english, `这些错误文案没有中文：\n${english.join("\n")}`).toEqual([]);
  });

  it("`showError` 取出 message，不许用 `String(error)`（会带「Error:」前缀 ✗）", () => {
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toMatch(/error instanceof Error \? error\.message : String\(error\)/);
    expect(main).not.toMatch(/flashStatus\(`打开失败：\$\{String\(error\)\}/);
  });

  it("Rust 侧上屏的错误串也不许带 HRESULT 行话（错误码只进 stderr ✓）", () => {
    const rust = readFileSync(path.join("src-tauri", "src", "print", "cdp.rs"), "utf8");
    expect(rust).not.toMatch(/Err\(format!\("打印引擎返回错误：hr=/);
    expect(rust).toMatch(/eprintln!\("\[print\] 打印引擎返回错误：hr=/);
  });
});
