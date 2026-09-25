/**
 * 样式表与超大文件的**行数预算门禁**（2026-09-23 · 批次 1）。
 *
 * 为什么需要它：
 *   宪法「代码铁律」写了「文件 ≤400 行」，但 eslint 的 files 只含 `src/**\/*.ts` 与 `tests/**\/*.ts`
 *   —— **样式表完全不被覆盖**。后果是 app.css 从 Phase 2 前的 957 行涨到 1437 行（+50%）也没人拦。
 *   本文件补上这条缺口：对"眼下已经超限"的文件用**棘轮**（ratchet）—— 先止住增长，拆分另行排期。
 *
 * 两档语义：
 *   hard = 硬上限，超过即**测试失败**（止住增长）
 *   soft = 软上限，超过只在输出里**告警**（提示该拆了），不阻塞
 *
 * ⚠ 拆分完成后请**把 hard 调小**（棘轮只往紧的方向转）。别把 hard 当"新的目标值"往上抬 ——
 *   那正是当初 app.css 从 957 长到 1437 的路径。
 *
 * ⚠ vitest 会把 `.css?raw` 桩化为空串，故一律用 fs 直读（cwd = 项目根，与 panel-unify.spec.ts 同）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Budget {
  file: string;
  soft: number;
  hard: number;
  /** 为什么定这个数 / 打算怎么拆 */
  note: string;
}

const BUDGETS: Budget[] = [
  {
    file: "src/app.css",
    soft: 1200,
    hard: 1600,
    note: "样式表不参与 400 行铁律 → 曾经从 957 涨到 1437。hard 先止住增长；按 §1…§13 分段物理拆分排在 Phase 2.5。",
  },
  {
    file: "src/typography/tokens.css",
    soft: 400,
    hard: 700,
    note: "10 组调色板 × 语义映射，天然偏长；但不得无限增长（新增主题走数据而非新块）。",
  },
  {
    file: "src/typography/cjk.css",
    soft: 400,
    hard: 700,
    note: "正文排版；print.css 是它的唯一覆盖层，注意别把打印规则搬进来。",
  },
  {
    file: "index.html",
    soft: 300,
    hard: 420,
    note: "壳层结构。结构增长优先用 JS 生成（见 empty-state.ts 的做法），不要一直堆静态节点。",
  },
  {
    file: "src/main.ts",
    soft: 400,
    hard: 780,
    note: "接线与启动逻辑全堆在一个文件里 → 仍超铁律 ≤400。**棘轮已收紧（批次 3-7，2026-09-23）**：顶栏拥挤态整段搬到 `src/app/shell-overflow.ts`（811→738 行）⇒ hard 900→780（只往紧的方向转；不要为了塞新代码往上抬，继续按段外移）。",
  },
  {
    file: "src/app/tabs.ts",
    soft: 400,
    hard: 700,
    note: "标签管理偏大，同 main.ts 属超限项，拆分排在 Phase 2.5。hard 同属棘轮，只往紧的方向转。",
  },
];

function lineCount(file: string): number {
  // 与 read 工具同口径：按 \n 切分，文件末尾无换行时不额外算一行
  const text = readFileSync(file, "utf8");
  return text === "" ? 0 : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

describe("行数预算门禁（棘轮）", () => {
  for (const b of BUDGETS) {
    it(`${b.file} 不超过硬上限 ${b.hard} 行`, () => {
      const n = lineCount(b.file);
      if (n > b.soft) {
        // 软上限：只告警，不失败（提示该拆了）
        console.warn(`[行数预算] ${b.file} = ${n} 行，已超软上限 ${b.soft}（硬上限 ${b.hard}）。${b.note}`);
      }
      expect(n, `${b.file} 超过硬上限 ${b.hard} 行（当前 ${n}）—— ${b.note}`).toBeLessThanOrEqual(b.hard);
    });
  }

  it("预算表本身有维护义务：每个条目都要写清怎么拆", () => {
    for (const b of BUDGETS) {
      expect(b.note.length, `${b.file} 的 note 太短，写清"为什么定这个数/打算怎么拆"`).toBeGreaterThan(10);
      expect(b.soft).toBeLessThan(b.hard);
    }
  });
});
