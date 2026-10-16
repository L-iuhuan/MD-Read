/**
 * C1 · Markdown 格式检查规则（editor/lint-rules.ts 纯函数）单测。
 * 契约：每条规则至少 1 触发例 + 1 不触发例；裸 $ 规则必含金额反例
 * （数学分隔符契约：`$1,000 与 $2,000` 是纯文本，禁止报）。
 * 只测纯函数——CM 接线（光标行静默 / 徽标 / 防抖）在 md-lint.ts，不在本文件范围。
 */
import { describe, expect, it } from "vitest";
import { lintLines, type LintIssue, type LintSeverity } from "../src/editor/lint-rules";

function sevCount(issues: LintIssue[], severity: LintSeverity): number {
  return issues.filter((d) => d.severity === severity).length;
}

describe("① 未闭合围栏（error）", () => {
  it("触发：``` 开栏到文末未闭合，报在开头围栏行", () => {
    const issues = lintLines(["```ts", "const a = 1;"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 1, severity: "error" });
    expect(issues[0]?.message).toContain("围栏");
  });
  it("触发：~~~ 变体同样检查", () => {
    expect(lintLines(["~~~"]).filter((d) => d.message.includes("围栏"))).toHaveLength(1);
  });
  it("不触发：成对围栏（``` 与 ~~~ 各一对）", () => {
    expect(lintLines(["```ts", "code", "```", "~~~", "code", "~~~"])).toHaveLength(0);
  });
});

describe("② 表格行列数不齐（error，表头 pipe 列数为基准）", () => {
  it("触发：表头 2 列、数据行 1 列，报在该数据行", () => {
    const issues = lintLines(["| 甲 | 乙 |", "| --- | --- |", "| 1 |"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 3, severity: "error" });
    expect(issues[0]?.message).toContain("列");
  });
  it("不触发：数据行与表头列数一致", () => {
    expect(lintLines(["| 甲 | 乙 |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"])).toHaveLength(0);
  });
});

describe("③ 块级 $$ 未配对（error）", () => {
  it("触发：单个 $$ 开块到文末", () => {
    const issues = lintLines(["$$", "a + b = c"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 1, severity: "error" });
    expect(issues[0]?.message).toContain("$$");
  });
  it("不触发：$$ 成对（含单行 $$ x $$ 形态）", () => {
    expect(lintLines(["$$", "a + b", "$$"])).toHaveLength(0);
    expect(lintLines(["$$ a + b $$"])).toHaveLength(0);
  });
});

describe("④ 加粗 ** 未配对（error，行内计数奇数报该行）", () => {
  it("触发：行内 ** 数量为奇数", () => {
    const issues = lintLines(["正文", "**加粗未闭合"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2, severity: "error" });
    expect(issues[0]?.message).toContain("加粗");
  });
  it("不触发：成对加粗 / 单星乘号 / 行内代码里的 **", () => {
    expect(lintLines(["**加粗** 正常", "a * b * c", "`** 不算`"])).toHaveLength(0);
  });
});

describe("⑤ 链接残缺（error，[文本] 后缺 (地址)）", () => {
  it("触发：[文本] 后无 (地址)", () => {
    const issues = lintLines(["参见[文本]的说明"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 1, severity: "error" });
    expect(issues[0]?.message).toContain("链接");
  });
  it("不触发：行内链接 / 引用链接 / 脚注 / 引用定义行", () => {
    expect(
      lintLines([
        "[文本](https://example.com)",
        "[参考文献][ref]",
        "[^1] 脚注标记",
        "[label]: https://example.com",
      ]),
    ).toHaveLength(0);
  });
});

describe("⑥ 裸 $…$ 疑似数学（warning，保守启发式）", () => {
  it("触发：内容含拉丁字母 / ^ / \\ ——疑似数学定界符", () => {
    const issues = lintLines(["公式 $x^2$ 在此", "行内 $\\frac{a}{b}$ 公式"]);
    expect(issues).toHaveLength(2);
    expect(sevCount(issues, "warning")).toBe(2);
    expect(issues.every((d) => d.message.includes("$"))).toBe(true);
  });
  it("不触发（金额反例，契约必测）：$1,000 与 $2,000 是纯文本，禁止报", () => {
    expect(lintLines(["价格 $1,000 与 $2,000 不等"])).toHaveLength(0);
  });
  it("不触发：单个 $ 无配对（金额常态）", () => {
    expect(lintLines(["花了 $5 买咖啡"])).toHaveLength(0);
  });
});

describe("⑦ 标题跳级（info，层级差 > 1）", () => {
  it("触发：H1 后直接 H3", () => {
    const issues = lintLines(["# 甲", "### 丙"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 2, severity: "info" });
    expect(issues[0]?.message).toContain("跳级");
  });
  it("不触发：逐级递进与回落", () => {
    expect(lintLines(["# 甲", "## 乙", "## 乙二", "# 新章"])).toHaveLength(0);
  });
});

describe("⑧ 同级列表项缩进不一致（info）", () => {
  it("触发：同为二级、乙 2 空格而丁 3 空格", () => {
    const issues = lintLines(["- 甲", "  - 乙", "- 丙", "   - 丁"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ line: 4, severity: "info" });
    expect(issues[0]?.message).toContain("缩进");
  });
  it("不触发：规整的嵌套与回落", () => {
    expect(lintLines(["- 甲", "- 乙", "  - 子项", "- 丙", "  - 子项二"])).toHaveLength(0);
  });
});

describe("围栏免疫：其余规则一律不进代码块", () => {
  it("围栏内的表格残行 / ** / $ / 标题 / 列表全部不报", () => {
    expect(
      lintLines([
        "```md",
        "| a | b |",
        "| - | - |",
        "| 1 |",
        "**未配对",
        "$x^2$",
        "### 伪标题",
        "- 列表",
        "  - 子",
        " - 缩进乱",
        "```",
      ]),
    ).toHaveLength(0);
  });
});

describe("分级口径", () => {
  it("八类问题的 severity 映射：结构问题 error、裸 $ warning、风格 info", () => {
    const issues = lintLines([
      "| a | b |", // 表头
      "| - | - |", // 分隔行
      "| 1 |", // 表格 error
      "**未配对", // 加粗 error
      "$x^2$", // warning
      "# 一", // 标题
      "### 三", // info
    ]);
    expect(sevCount(issues, "error")).toBe(2);
    expect(sevCount(issues, "warning")).toBe(1);
    expect(sevCount(issues, "info")).toBe(1);
  });
});
