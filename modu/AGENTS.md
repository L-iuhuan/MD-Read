# AGENTS.md — 墨读（MoDu）

> 只写"agent 否则会搞错的事"。需求与架构裁决以 `docs/specs/2026-09-21-墨读设计规格.md`（**v1.4**）为唯一事实源；本文件是环境与铁律的执行层。
> （2026-09-23 同步：规格标题此前停在 `v1.1`，而其 §10 变更记录早已到 `v1.3` —— 本次补录 D-22 时一并升到 **v1.4**，两处对齐。）

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
- **窗口尺寸**：`tauri.conf.json` 的 `window.width/height`（默认 1680×1200）**就是**窗口尺寸。
  启动时只做「保证装得下」：读窗口**当前**逻辑尺寸，**只往下夹**到主屏工作区可用区
  （宽 −400 / 高 −80；极小工作区退到 `minWidth`/`minHeight`），**绝不放大、绝不覆盖
  config / `--config` overlay 的显式尺寸**，随后在**该尺寸**下于主屏工作区居中
  （位置由工作区算出，不用 `center()`）。读不到可信请求值时保留 config 尺寸、只摆位置。
  **不使用窗口状态持久化**，故每次启动尺寸/位置一致，便于测试对比。
  因此 CDP overlay 能各自钉住尺寸：默认 overlay 1680×1200、窄窗 overlay 900×750
  （2026-09-23 实测：窄窗 overlay 起来就是客户区 900×750、窗口 916×759、居中 (830,321)、
  在工作区内）。
  ⚠ 本条 2026-09-23 第二批改准过：旧文写「宽 ≤1680 且 ≤工作区宽−400」，那是已被废弃的
  「无条件取理想尺寸」语义——它会把 overlay 声明的尺寸**覆盖掉**（窄窗 overlay 长期失效）。

- **窗口有时启动即最小化（未确认，勿追）**：2026-09-23 窄窗测试时观察到窗口偶尔一起来就是最小化态
  （`tauriPos -32000,-32000`、`showCmd=2`、`innerSize 144×19`）。**已排查并排除**：与本项目代码无关
  （全仓最小化调用只有 `main.ts` 的 `win-min` 按钮；`adjust_window_size` 里没有任何 ShowWindow/minimize）、
  与 config/overlay 尺寸无关（两次运行配置逐字节相同、一次最小化一次正常）、也不是启动器 show-state 泄漏
  （同一后台作业机制启动 `regedit` 得到 `iconic=False` 正常 1920×1023）。
  **关键旁证**：每次最小化时窗口 `normalRect` 都正确（如 830,321 / 916×759）⇒ 建窗、定尺寸、居中全对，
  最小化发生在之后。`SW_RESTORE` 后静置 45s 无自发最小化。
  **最可能的原因：自动化测试会让应用自动打开，人正在做别的事时顺手把它最小化掉了**（用户本人也不确定）。
  → **不要为它改产品代码**；测试需要窗口可见时用 Win32 `SW_RESTORE` 还原即可。**若以后频繁复现再另立调查**。
  **新旁证（2026-09-23 第二批，弱但指向一致）**：该批再次出现 minimize 的时刻，恰在测试"真点击 `＋`
  → 弹出原生文件对话框 → 用 `WM_CLOSE` 关掉"之后。**原生对话框会抢焦点** —— 而这正是"人在做别的事时
  顺手把它最小化"最容易发生的时刻。⇒ 与上面"人干的"这一解释**方向一致**，不构成代码缺陷的证据。

## 测试隔离：localStorage / 受信清单（2026-09-23 实测，**别再用 `dataDirectory`**）

- **`app.windows[].dataDirectory` 不可靠，别再用**：其文档语义是"相对 `appDataDir()/${label}`"且明说含 Windows，
  但**实测什么都没建**（`%APPDATA%\com.modu.reader\main\.verify-*\` 为空），真实 profile 照旧被写
  ⇒ 四个 overlay 里那行 `"dataDirectory": ".verify-cdp"` **从来不是隔离**。
- **有效做法：启动前置 `WEBVIEW2_USER_DATA_FOLDER=<绝对隔离路径>`**（WebView2 官方 UDF 覆盖，**Tauri 不覆盖它**）。
  实测：隔离目录建出完整 `EBWebView\{Default,BrowserMetrics,CertificateRevocation,…}`；
  且**真实 profile 的 9 个 leveldb 文件与备份逐字节一致**（事后独立复核）。**产品 `tauri.conf.json` 不用改**（8MB 红线不碰）。
- **受信清单 `%APPDATA%\com.modu.reader\trusted-paths.json` 不在 WebView2 管辖内** ⇒ 靠**启动包装脚本**
  （`.verify/phase3b/run-isolated.mjs`）：**启动前**快照（含"目录/文件原本是否存在"）+ **任何退出路径**都还原
  （原本不存在 ⇒ **删掉**，别写 `{}`，否则凭空造文件、下次快照对不上），并**还原后再读一次比 SHA**。
  ⚠ **快照若在应用启动之后拍 = 假还原**：`true` 只说明"前后一样"，而那个"前"**已经被本次启动污染**了
  —— 本会话真实踩过，它会一直给人"受信清单是干净的"错觉。
- ⚠ 换新 profile 后**首屏更慢** ⇒ **所有探针必须先等就绪信号再动作**（如 `window.__moduDev` 出现，带超时），
  **不许固定 sleep**；超时信息要能区分"应用没就绪"与"dev 钩子没注入"（同"探针先确认前置条件再动作"的纪律）。
- ⚠ 应用运行中 leveldb 被锁（读会 `EBUSY`）⇒ 要读**隔离 profile 的 leveldb 先停应用**；运行期只能读页面里的 `localStorage`。
- 现成工具：`.verify/phase3b/{run-isolated.mjs（包装：前置检查+启动前快照+多路径还原）, probe-isolation.mjs（三项验收探针）, extract-recent2.mjs（leveldb 只读取证，注意 UTF-16LE 奇偶偏移）}`。

## 性能归因（已实测，别再走弯路）

- **滚动期的 `IntersectionObserverController::computeIntersections`（占墙钟 ~30%，6.8ms/帧）不是大纲的
  IntersectionObserver 造成的，而是 `content-visibility: auto`**（Blink 用它算"哪些块可跳过渲染"，
  本语料候选 9,429 个 `.mdc > *` 块）。三组决定性实验（2026-09-23 · X2 批次，同语料/同会话/6s 确定性滚动）：
  ① 彻底去掉标题观察器（`IO.observe` 4,715 → 0）→ 该计数器**仍是 1,790.6ms/6s**；
  ② 手工加回"观察 4,715 个标题"→ 只涨 **+145ms/6s（+0.8ms/帧）**；
  ③ **关掉 `content-visibility:auto`** → 该计数器 **4.7ms**（Layout/Paint 随之上升）。
  ⇒ 《性能实验报告-2026-09-23》§3.3① 的旧归因**已作废**（报告文首有勘误）；
  权衡净账与候选方案见 `docs/tasks/Phase2-content-visibility权衡提案-2026-09-23.md`。
- **归因纪律**（本项目的血泪）：要归因给 X，就把 X 开/关并**只测你指控的那个指标**；
  "改了别的东西、别的指标变好了"不算证明；两个机理共用同一批对象时必须用**第三组实验**把它们拆开。
  **报告里的归因句必须显式标注"实测 / 推断"** —— 下游 agent 会把推断当实测用。
- 报告里"某个热点的归因"**改动产品代码前先重测那个计数器**：本批 X2 就是先按旧归因动手，
  做完才发现真正的原因在别处（收益仍在，但不是预期的那个）。
- **`content-visibility` 已按文档形态分层开启（P1，2026-09-23）**：判据在
  `src/render/offscreen-policy.ts`（纯函数，含单测），挂载时给 `#doc` 挂 `.cv-off`：
  · **含 KaTeX / Mermaid → 保留**（实测公式文档"开着"打开快 558ms、p95 低 17%）；
  · **无重块且 `#doc` 直接子元素 ≥ 2,000 → 关掉**（实测交叉点：1,376 块两态持平、2,353 块起"关掉"
    下行 FPS 高 41% 而打开只贵 86ms；散文 1MB 18.37 → 57.18 FPS、阶梯-20K 34.67 → 74.47）；
  · **其余一律保留** —— 基础 CSS 规则不动，所以**漏判/判错的代价只是"回到今天的行为"**，
    这是硬要求（别把默认翻成"关"）。
  ⚠ 判据的量是**候选块数**（`childElementCount`，O(1)）而**不是 DOM 节点数**：长段落 2.4 万节点只有 401 块
  （两态持平），阶梯-20K 3.1 万节点有 5,326 块（关掉 +115%）—— 拿节点数当判据会判错。
  ⚠ **未测边界**：KaTeX 密集且块数 ≥ 2 万（重块收益与判定成本都高）没有语料，现按"含重块保留"处理。
  语料生成器 `tests/corpus/生成P1语料.mjs`（生成物写进 gitignore 的 `.verify/phase2/p1-corpus/`，
  别把 29MB 语料入库）；净账与决策表见 `docs/tasks/Phase2-P1分层开启报告-2026-09-23.md`。
- **大纲跟随的"首屏高亮"在挂载时现算**（`mountRendered` 里 `outlineFollow.update()` 紧跟 `reset()`）：
  X2 改成"滚动帧内二分"后高亮只在滚动事件里更新 ⇒ 曾出现"打开不滚动则大纲一条不亮"的回归
  （P1 批次回归检查发现并修掉）。**改这条链路时：等价性验收必须包含"完全不滚动"的初始态。**

## 性能预算与设计范围（2026-09-23 用户口径：**打开速度优先**）

**设计范围 = ≤200 页 / ≤2,000 个 `#doc` 直接子元素 / ≤1MB 的常规 Markdown**（含少量代码、表格、公式）。
**>200 页、>2,000 块、>2MB 明确不在设计范围** —— 不要为它们加判据、上界或特判
（P1 的阈值就停在既有 2,000，**没有新增块数上界**）。

| 指标 | 预算 | 实测（CV 开=现状，本机） |
|---|---|---|
| 冷开 click→挂载完成，≤10 页 | ≤ 80 ms | 38 ms |
| 冷开，≤30 页 | ≤ 100 ms | 43 ms（含 38 个公式 62 ms） |
| 冷开，≤100 页 | ≤ 200 ms | 102 ms |
| 冷开，≤200 页 | ≤ 300 ms | 165 ms |
| 滚动（确定性下行 3×6s + 真实滚轮） | **≥ 55 FPS** | 73.6 ~ 75.0（贴 vsync 75） |
| 打开期长任务 | ≤30 页 0 个；≤100 页 ≤1×60ms；≤200 页 ≤1×110ms | 0 / 1×56 / 1×100 |
| `read_file` IPC（200 页档） | ≤ 80 ms | 52 ms |

- **"页"怎么量**：常规形态 **1 节 ≈ 0.74 页 A4**；200 页 ≈ 367KB ≈ **1,726 块**
  ⇒ **P1 的 2,000 块阈值在目标区间内不触发**（该区间恒为"开着"：打开代价 0、滚动收益 0）。
- **目标区间打开归因（实测）**：总时长的 **64%~77% 是「渲染+挂载」段**，`read_file` IPC 只占 11%（10 页）→ 32%（200 页）；
  ≤30 页**没有长任务**；内部各库占比散在 DOMPurify/DOMParser/pangu/tokbreak，**没有单一热点**（推断，据 V8 profile）。
  ⚠ 旧结论"几乎全在 read_file IPC"是 **2MB 文档**上的读数，**不适用于常规文档**。
- **"打开后延迟关掉 content-visibility"已实测：有条件成立但不做**（200 页档：打开回到 137ms、滚动回到 74.97，
  但切换瞬间一次 52ms 长任务 + 视口内容位移 256 行 + 状态栏/进度/大纲陈旧到下次滚动才自愈，而目标区间滚动本就是 vsync）。
  ⚠ 若将来真要引入"布局变化后内容重排"，**必须先补"布局变化后主动刷新状态栏/进度/大纲"的路径**。
- **复跑方法（回归自查）**：`node modu/tests/corpus/生成常规文档语料.mjs` → 起 CDP 应用 →
  `node .verify/phase2/p1/probe-cal-pages.mjs 9222`（页数应为 11/31/30/101/201）→
  `node .verify/phase2/p1/probe-w-open-attrib.mjs 9222`（打开归因/长任务/IPC）→
  `node .verify/phase2/p1/probe-r-regular.mjs 9222`（三态打开与滚动）。
  口径：打开取 `openClick→loadingOff`；滚动取 3×6s 确定性下行中位 FPS；长任务窗口取 `[openClick, loadingOff+800]`。
  净账与判决见 `docs/tasks/Phase2-常规文档打开性能报告-2026-09-23.md`。

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
- **宽表打印三层**（用户裁决 2026-09-23，已实施；判据在 `src/render/print-ready.ts` 的 `markPrintBlocks`，
  **导出流程里调用**，屏显零影响）：判据量的是**表自身的 `min-content` 宽**（临时 `inline-size:min-content`
  同步读回再还原）—— 别退回 `max(表,容器)` 口径：`.mdc table{inline-size:100%}` 会把任何表撑到容器宽
  （本机 ~734px），实测把一张 3 列小表也误判成宽表。
  · `w ≤ 658` → 竖版自然宽；
  · `658 < w ≤ 987` → 打 `wide-page` ⇒ `@page wide { size: A4 landscape }` **横排**（不压列）；
  · `w > 987` → 再打 `squeeze-page` ⇒ `table-layout:fixed` + **`inline-size: calc(261mm - 2mm)`** + 单元格
    `overflow-wrap:anywhere` **压列换行**（C 落地后实测：12 列全印出、**9 页**（p4–p8 横）、**11 行/页**、
    表宽 259.33mm、每列 21.74mm≈**6.3 个汉字**（推断）、长 token 断 2 行、45 行无丢无重无腰斩）。
  `658`/`987` = 竖版 174mm / 横版 261mm 按 96dpi 换算（**纸型实测**：竖 594.96×841.92pt、
  横 841.92×594.96pt；mm⇒px 属推断）—— 改这两个数必须同步改那边注释里的推导线。
  **禁缩放 / `transform` / 光栅化 / 拆列**。
  ⚠ **最易再踩的坑（归因轮实测，2026-09-23）**：**横版命名页的"排版内容盒"仍是最初 `@page`（竖版）的
  174mm** —— `@page wide { size: A4 landscape }` 只把**纸**变成横版，**内容宽没变**：表格写百分比只等于
  174mm（墨迹实测 173.99mm，纸上右侧 ~87mm 永远空着）。**清 `.mdc`/`#doc`/`.body-row`/`#content` 的
  `max-inline-size` 完全无效**（B/D 变体与基线墨迹一字不差 ⇒ 限制**不在**我们的阅读栏宽）。
  所以 `.squeeze-page` 的表**必须给物理宽**：`inline-size: calc(261mm - 2mm)`（261mm = 横版可印宽
  297−2×18，减 2mm 留安全边；落地后实测表宽 259.33mm、右边界 277.11mm ≤ 278.64mm ✓）。
  **禁止改回 `100%`**（`tests/print-overflow.spec.ts` 有锚）。
  ⚠ `261mm` 与 `LANDSCAPE_PRINTABLE_PX = 987`（261mm ≈ 987px@96dpi）**同源耦合**：改 `@page` 边距或
  这两个数，必须同步另一边。
  ⚠ **「可能被截」的中文提醒已撤除**（2026-09-23）：压列后表格不丢列、`.mdc img{max-inline-size:100%}` 在、
  `pre` 会换行 ⇒ **已无会静默丢内容的类别**，留着就是会撒谎的提示。**别再把它加回来**，
  除非确实新增了会截断的类别（且先有真能触发它的用例）。
  命名页受支持是**实测**的（含"不加命名页 → 三页全竖"的决定性对照）；横版页上
  `tr{break-inside:avoid}` + `thead{display:table-header-group}` 同样成立。详见
  `docs/tasks/Phase3-批次2-超宽表压列-2026-09-23.md`。

## 编码契约

- 读：UTF-8 优先，GB18030 回退检测
- 写：**保持原编码**，禁止静默转 UTF-8；状态栏显示当前编码

## 数学分隔符（财务场景，不可协商）

仅 `$$...$$` 块级 + `\(...\)`/`\[...\]` 行内；**禁用裸 `$...$`**——`$1,000 与 $2,000` 是纯文本。golden 语料必须含金额串。
**`typographer` 必须关**（用户裁决 2026-09-23）：`src/render/markdown.ts` 里一律 `false` —— 不静默改掉
有字面含义的文本（`--flag`、区间 `1--2`、`"key": value`、`...`）；中文破折号本是 `——`，自动变西文 en dash
既非原样也非中文化。**与"禁裸 `$…$`"同源**。改前/改后必须过 golden-HTML 对拍（diff **只允许**
`–`→`--`、`…`→`...`、弯引号→直引号）；`tests/render.spec.ts` 有静态锚（`typographer: false` + 反向锚），
真机验过"渲染与源码逐字一致"（见 `docs/tasks/Phase3-决策台账-2026-09-23.md` D-P3-1）。**别改回 true。**

## 流程

- 每里程碑收工给凭证：改了什么/验证输出/遗留风险；tag 规范 `m0-done`…`m5-done`
- 提交信息 `类型: 中文描述`（feat/fix/docs/chore）
- 渲染改动过 golden-HTML 对拍（固定语料含金额串/引号/data-line）
