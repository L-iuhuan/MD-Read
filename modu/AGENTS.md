# AGENTS.md — 墨读（MoDu）

> 只写"agent 否则会搞错的事"。需求与架构裁决以 `docs/specs/2026-09-21-墨读设计规格.md`（v1.1）为唯一事实源；本文件是环境与铁律的执行层。

## 项目

个人自用 Windows Markdown 阅读器。Tauri 2 + vanilla TS + 手写 CSS，禁 React/Vue。产物 .msi ≤8MB 硬门禁。规格 `docs/specs/`，评审记录 `docs/review/`，任务书 `docs/tasks/`。

## 环境怪癖（两台开发机）

- **双机**：内网机（公司内网）/ 外网机（家机外网），代码走 git（`pull --rebase` 再 push）。提交身份为中性 `MD-Read <noreply@example.com>`（仓库 local 已配；历史已重写为该身份；**不要**改回个人身份）。
- **公司机已配镜像**：crates 走清华 sparse（`~/.cargo/config.toml` + 用户级 `RUSTUP_DIST_SERVER`），npm 走 npmmirror。**不要**改回官方源（index.crates.io 4.4s/次）。
- **PowerShell 5.1 stderr 坑**：原生长程序（rustup/cargo/tauri）进度写 stderr，`$ErrorActionPreference='Stop'` + `2>&1` 会假死中断——用 `*> file.log` 重定向再看尾行。已在 rustup 安装时翻车一次。
- **PATH 陷阱**：agent 宿主进程在装 Rust 之前启动，其子进程 PATH 无 `~/.cargo/bin`——每个新 shell 会话先 `$env:PATH="$env:USERPROFILE\.cargo\bin;"+$env:PATH`（rustup 写的是用户级 PATH，宿主重启后自动生效）。
- **vite dev 缓存陷阱**（2026-09-21 实翻车）：依赖变更后 `vite build`（rollup）正常但 `tauri dev` 页面崩（如 "Invalid top rule name SingleExpression"）——`node_modules/.vite` 预打包缓存陈旧。修法：删 `node_modules/.vite` 重启 dev。**症状特征：车道自检（check/build）全绿而 dev 实例白屏/模块炸。**
- **bundle 配置串必须 ASCII**（2026-09-21 实翻车，P-44 同族）：`tauri.conf.json` 里 fileAssociations 的 description 用中文 → WiX `light.exe` 打包失败（wxs 编码坑）。规则扩展：**productName 与一切进 wxs/nsis 的配置串一律 ASCII**，中文只出现在窗口标题/界面文案。
- 工程内层路径保持 ASCII（`modu/`）；仓库根是中文路径，cargo/NSIS 在中文路径下有历史坑，**不要**把 src-tauri 移到中文子目录。
- `tauri build` 首次打包要从 GitHub 下载 WiX/NSIS 到 `%LOCALAPPDATA%\tauri`；公司机失败时用家机打包的缓存目录带回（见 M0 任务书）。
- DSE 透明加密环境（公司机）：.md 理论不加密，M1 须读写双测验证；读文件前不验头（文本格式）。

## 代码铁律（TS 侧）

- 函数 ≤50 行；文件 ≤400 行纯代码（UI 组件可到 400，逻辑文件自觉 250）
- 全类型注解，禁 `any`；`tsc --strict` 必过；禁宽 catch/空 catch——catch 具体异常
- 错误信息中文、面向使用者，不露技术黑话
- 依赖新增须过评审（8MB 门禁）；markdown 渲染相关优先用维护中插件，禁手写正则 hack（protectMath 尸检教训）
- **安全三项**（渲染层按"已被攻陷"设防）：CSP 显式维护（tauri.conf.json）；Tauri capabilities 路径 scope 收紧；渲染管线过 DOMPurify。`html:true` 禁止开启

## PDF 规则（Print Studio 尸检结论，违者返工）

- 禁 `@page` margin-box（`@bottom-center`/`counter(page)`）——**历史上 Chromium 未实现，131+ 已支持；但本项目经评审决定不使用**（理由：保持打印契约的单一覆盖层，并与 WebView2 `PrintSettings` 的行为一致）。页码走 CDP `Page.printToPDF` 的 `footerTemplate`（见 print.rs）
- 禁 jsPDF/html2canvas 光栅化路径——公式变糊根因
- `@page { size: A4; margin: 18mm }`，body 不放页边距；表格行级分页 `tr{break-inside:avoid}` + `thead{display:table-header-group}`
- `.katex-mathml { display: none }` 防 PDF 鬼影重复文字
- 打印前必须 await 渲染完全部懒加载块
- print.css 是 cjk.css 的唯一覆盖层，**禁止出现第三份打印样式**

## 编码契约

- 读：UTF-8 优先，GB18030 回退检测
- 写：**保持原编码**，禁止静默转 UTF-8；状态栏显示当前编码

## 数学分隔符（财务场景，不可协商）

仅 `$$...$$` 块级 + `\(...\)`/`\[...\]` 行内；**禁用裸 `$...$`**——`$1,000 与 $2,000` 是纯文本。golden 语料必须含金额串。

## 流程

- 每里程碑收工给凭证：改了什么/验证输出/遗留风险；tag 规范 `m0-done`…`m5-done`
- 提交信息 `类型: 中文描述`（feat/fix/docs/chore）
- 渲染改动过 golden-HTML 对拍（固定语料含金额串/引号/data-line）
