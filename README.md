# 墨读 MoDu

**个人自用的 Windows Markdown 阅读器 + PDF 导出器。** 面向"读"而不是"写"：打开即读、长文档不卡、导出的 PDF 干净可直接给人看。

技术栈刻意保持极简：**Tauri 2 + 原生 TypeScript + 手写 CSS**（不用 React/Vue），产物 `.msi` **≤ 8 MB** 是硬门禁（当前 4.23 MiB）。

---

## 能力

| 方面 | 说明 |
|---|---|
| **阅读** | Markdown 渲染（markdown-it）、KaTeX 公式、highlight.js 代码高亮、Mermaid 图（按需懒加载）、中文排版优化 |
| **多文档** | 标签页、标签条滚动（`‹ › ▾` + 滚轮横滚）、最近文件、拖入文件、双击 `.md` 关联打开、单实例（二次打开进已有窗口新标签） |
| **大纲** | 侧栏大纲，滚动实时跟随当前标题；`☰` 折叠 |
| **查找** | `Ctrl+F` 文档内查找并高亮 |
| **编辑** | `Ctrl+E` 在阅读/编辑间切换（CodeMirror 6）、`Ctrl+H` 替换、`Ctrl+S` 保存 |
| **导出** | 导出 PDF：**无页眉**、页脚仅居中页码（「— 3 —」） |
| **外观** | **5 套主题 × 亮/暗**（靛蓝 · 宣纸 · 石墨 · 紫黛 · 青墨）；字号与行宽可调；字体面板可切换并**显示"实际生效的字体"** |
| **编码** | 读：UTF-8 优先、GB18030 回退检测；写：**保持原编码**，不静默转 UTF-8 |

---

## 安装

从 [Releases](https://github.com/L-iuhuan/MD-Read/releases) 下载 `.msi` 安装，或直接运行 `MSI` 后双击任意 `.md` 文件。

要求：Windows 10/11（依赖系统自带的 WebView2 运行时）。

---

## 使用要点（有两条是硬约束，值得先看一眼）

### 1. 数学分隔符：只认 `$$…$$` / `\(…\)` / `\[…\]`，**裸 `$…$` 不生效**

这是**为财务场景刻意做的选择**：`$1,000 与 $2,000` 里的 `$` 是**金额符号**，不是公式定界符。如果支持裸 `$…$`，这类文本会被误当成公式。

- ✅ 块级：`$$ … $$`
- ✅ 行内：`\( … \)` 或 `\[ … \]`
- ❌ 行内：`$ … $` —— **按纯文本原样显示**

### 2. 设计范围：**≤ 200 页 / ≤ 1 MB 的常规 Markdown**

本应用为**常规文档**（典型几十页）优化，性能预算（见 `modu/AGENTS.md`）：

| 指标 | 预算 | 实测（本机） |
|---|---|---|
| 冷开 ≤ 10 页 | ≤ 80 ms | 38 ms |
| 冷开 ≤ 30 页 | ≤ 100 ms | 43 ms（含 38 个公式 62 ms） |
| 冷开 ≤ 100 页 | ≤ 200 ms | 102 ms |
| 冷开 ≤ 200 页 | ≤ 300 ms | 165 ms |
| 滚动 | ≥ 55 FPS | 73.6 ~ 75.0（贴显示器 vsync） |

**远超这个规模（数千页 / 数十 MB）不在设计范围内**，也不必为它加特判 —— 阅读区虚拟化是另一个量级的改造。

---

## 开发

### 环境

- **Node.js** + **pnpm**
- **Rust**（stable）与 `cargo`
- Windows（本项目**只支持 Windows**：依赖 WebView2 与 Windows 打印链路）

### 常用命令（在 `modu/` 下）

```powershell
pnpm install
pnpm tauri dev        # 开发运行
pnpm tauri build      # 打包（产出 msi / nsis）
pnpm run check        # 全量门禁：tsc ×2 + eslint + vitest
```

Rust 侧测试**必须在 `modu/src-tauri/` 下跑**（`modu/` 没有 `Cargo.toml`，在 `modu/` 下会报 `EXIT=101`）：

```powershell
cd modu/src-tauri
cargo test
```

### 全部门禁

| 门禁 | 命令 | 当前基线 |
|---|---|---|
| 类型 + lint + 单测 | `pnpm run check`（在 `modu/`） | EXIT 0 · 476 条断言 · eslint 0 error |
| Rust 单测 | `cargo test`（在 `modu/src-tauri/`） | EXIT 0 · 31 + 4 passed |
| 敏感信息扫描 | `scripts/check-sensitive.ps1` | 0 命中 |
| 安装包体积 | `pnpm tauri build` 后看 `.msi` | **≤ 8 MB**（当前 4.23 MiB） |
| 行数预算（棘轮） | 含在 `pnpm run check` 里 | `modu/tests/css-budget.spec.ts` |

### 改代码前请先读

- **`modu/宪法.md`** —— 项目红线（打印、安全、编码、数学分隔符等），**违者返工**
- **`modu/AGENTS.md`** —— 环境怪癖、代码铁律、**性能归因结论与预算**、踩过的坑（很多是"照着旧结论动手会白干"的教训）
- **`docs/specs/`** —— 需求与架构裁决的唯一事实源

---

## 仓库结构

```
modu/
  index.html            壳层结构
  src/
    main.ts             接线与启动
    app/                业务模块（tabs / recent / drop / outline-follow / md-ext …）
    ui/                 界面模块（findbar / settings / theme / font-* / close-confirm / empty-state …）
    render/             渲染管线（markdown-it 插件、KaTeX、Mermaid、打印就绪、离屏策略）
    typography/         tokens.css（**色值与刻度的唯一落点**）/ cjk.css / hljs.css / print.css
    app.css             壳层与面板样式
  src-tauri/            Rust 侧（fs 读写与编码、CDP 打印、单实例、窗口）
  tests/                vitest（含大量"静态锚"：把已修过的坑钉住，防回归）
docs/specs/             设计规格（唯一事实源）
scripts/                敏感信息扫描门禁
```

> 过程产物（任务书、评审记录、演示、参考资料）**刻意不进本仓库**，只作本地留档。

---

## 安全模型

渲染层按"**已被攻陷**"设防：

- `html: true` **永久禁用**；渲染管线过 DOMPurify
- CSP 在 `tauri.conf.json` 里显式维护；Tauri capabilities 的路径 scope 收紧
- 文件读写经 Rust 侧做**受信路径**校验，渲染层不能对任意路径读写

---

## 许可

[MIT](LICENSE)
