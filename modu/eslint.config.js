/**
 * eslint 扁平配置（A1：补齐宪法强规 1 的「tsc --strict + eslint + vitest」三件套）。
 *
 * 规则口径（刻意克制，避免门禁变红后靠改业务代码迎合 lint）：
 *  - @typescript-eslint/no-explicit-any = error（宪法强规 2「禁 any」，实测 0 处）
 *  - no-empty = error（宪法强规 2「禁空 catch」，实测 0 处）
 *  - max-lines(400) / max-lines-per-function(50) = 暂为 warn：
 *      存量欠账见 docs/tasks/Phase2-前-代码审查报告-2026-09-23.md §2.1/§2.2
 *      （main.ts 708 行、editor.ts 491、tabs.ts 461；createTabManager 277 行、
 *        createEditSession 202、boot 90、createEditor 76、setupFindbar 75、
 *        setupTabDnd 64、collectHits 58；以上为审查报告实测值，A4 加日志后其中 5 个文件各 +1 行），
 *      待 Phase 2.5 拆分后转 error。
 *  - 其余走 typescript-eslint 的 recommended；若某条 recommended 规则产生大量
 *      告警，改设 warn 并在此注明，不靠改业务代码迎合 lint。
 */
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // 只审手写 TS：构建产物、Rust 侧、依赖目录不进 lint
    ignores: ["dist/**", "node_modules/**", "src-tauri/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node, // tests/ 下读语料用的是 node:fs
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-empty": "error",
      // 与 tsc 的 noUnusedParameters 口径对齐：下划线前缀 = 有意不用的形参
      // （tests/multidrop.spec.ts:75 的 `_activate` 就是这种写法；不新增噪声，也不放行真未用变量）
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // 暂为 warn：存量欠账见 docs/tasks/Phase2-前-代码审查报告-2026-09-23.md §2.1，待 Phase 2.5 拆分后转 error
      "max-lines": ["warn", { max: 400 }],
      // 暂为 warn：存量欠账见 docs/tasks/Phase2-前-代码审查报告-2026-09-23.md §2.2，待 Phase 2.5 拆分后转 error
      "max-lines-per-function": ["warn", { max: 50 }],
    },
  },
);
