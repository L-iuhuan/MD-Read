# 墨读 MoDu —— modu/（应用本体）

中文优先的 Windows Markdown 阅读器：**阅读为主、轻量编辑、PDF 导出**。Tauri 2 + 原生 TypeScript + 手写 CSS（不用前端框架）；仅支持 Windows（依赖 WebView2 与系统打印链路）。

核心能力：markdown-it 渲染（GFM/脚注/emoji）· KaTeX 公式 · 代码高亮 · Mermaid 懒加载 · 中文排版优化｜多标签 · 大纲滚动跟随 · 最近文件 · 双击 `.md` 关联打开 · 单实例｜CodeMirror 6 轻量编辑（UTF-8/GB18030、BOM/CRLF 保真）｜CDP 静默导出 PDF（无页眉、页脚仅页码）。

| 快捷键 | 作用 |
|---|---|
| `Ctrl+E` | 阅读 ⇄ 编辑切换 |
| `Ctrl+F` / `Ctrl+H` | 查找 / 替换（替换为编辑态面板；阅读态 `Ctrl+H` 无动作） |
| `Ctrl+S` / `Ctrl+P` | 保存 / 导出 PDF |
| `Ctrl+W` | 关闭当前标签（有未保存改动先确认） |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Esc` | 标签循环切换 / 依次收起浮层 |

- 安装与下载见[仓库根 README](../README.md)（Releases）；开发指引先读 [AGENTS.md](./AGENTS.md)（铁律与坑速查）与 [宪法.md](./宪法.md)（红线），命令与门禁见根 README「开发」节。
