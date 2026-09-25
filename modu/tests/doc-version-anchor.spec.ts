/**
 * 文档版本号一致性锚（3-2 防复发，2026-09-23）。
 *
 * 背景：规格**标题**曾停在 `v1.1` 而其 **§10 变更记录**早已到 `v1.3`（滞后两版），
 * 且 `AGENTS.md` 引用的也是旧号 —— 属"文字与事实不符"，不该靠人记得核。
 * 本锚断言三处编号一致：规格 L1 标题 == §10 最后一条变更记录 == `AGENTS.md` 引用的规格版本。
 *
 * ⚠ 降级纪律（同敏感门禁的"缺词条文件时降级"做法）：`docs/specs/` 若被移出仓库或改名，
 * 本锚**跳过**（不假红）。
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SPEC = "../docs/specs/2026-09-21-墨读设计规格.md";
const AGENTS = "AGENTS.md";

/** 从一行里取 `vX.Y`（忽略 -rc 之类的后缀） */
function versionOf(line: string): string | null {
  const m = line.match(/v(\d+\.\d+)/);
  return m === null ? null : m[1];
}

describe("文档版本号一致性锚（规格标题 / §10 变更记录 / AGENTS.md）", () => {
  it("三处版本号一致；docs/specs 缺失时跳过", () => {
    if (!existsSync(SPEC)) {
      return; // 降级：文档可能已移出仓库，不假红
    }
    const specLines = readFileSync(SPEC, "utf8").split(/\r?\n/);
    const titleVersion = versionOf(specLines[0] ?? "");
    const changelogVersions = specLines
      .filter((line) => /^-\s*v\d+\.\d+/.test(line))
      .map(versionOf)
      .filter((v): v is string => v !== null);
    const latestVersion = changelogVersions[changelogVersions.length - 1] ?? null;

    expect(latestVersion, "规格 §10 变更记录里没找到任何 vX.Y 条目，锚失效").not.toBeNull();
    expect(
      titleVersion,
      `规格 L1 标题版本与 §10 最新变更记录不一致：标题写 v${titleVersion}、变更记录最新是 v${latestVersion}（改规格时请同步标题）`,
    ).toBe(latestVersion);

    if (!existsSync(AGENTS)) {
      return;
    }
    const agentsSpecLine =
      readFileSync(AGENTS, "utf8")
        .split(/\r?\n/)
        .find((line) => line.includes("墨读设计规格.md")) ?? "";
    const agentsVersion = versionOf(agentsSpecLine);
    expect(
      agentsVersion,
      `AGENTS.md 引用的规格版本与规格当前版本不一致：AGENTS.md 写 v${agentsVersion}、规格是 v${latestVersion}`,
    ).toBe(latestVersion);
  });
});
