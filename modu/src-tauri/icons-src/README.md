# MoDu 图标资产（icons-src → icons）生成口径

本目录是 Windows 图标的**唯一矢量源**；`../icons/` 下的 `.ico` / `.png` 由
`modu/tests/tools/build-icons.py` 从这里的 SVG 光栅化得到，**不要手工改位图**。
`icon.icns`（仅 macOS）不参与本流程，保持原样。

## 文件

| 文件 | 用途 | 视觉语言 |
| --- | --- | --- |
| `f1-app.svg` | **细节版** app 图标（>48px） | 渐变纸页、折角、柔和投影、细笔 M↓ |
| `f1-file.svg` | **细节版** `.md` 文件图标（>48px） | 同上，无投影、M 略粗 |
| `f1-app-small.svg` | **小尺寸版** app 图标（≤48px） | 平涂、粗外框、大 M↓、无渐变/阴影/filter |
| `f1-file-small.svg` | **小尺寸版** `.md` 文件图标（≤48px） | 同上，M 占比略大 |
| `f2-app.svg` / `f2-file.svg` | 历史方向稿，**不参与构建** | — |

品牌三元素在四个文件里一致：**纸页 + M↓ + 朱砂书签**。

## 尺寸集合与来源（为什么需要 10 档）

Windows 按物理像素挑图标；本机 125% 缩放（LogPixels=120）下任务栏 32 逻辑 → **40 物理**、
标题栏 16 逻辑 → **20 物理**，而旧 ICO 缺 20/40，只能拿邻近尺寸缩放 ⇒ 糊。

| 像素 | 来源 | ICO 条目格式 | 典型使用场景 |
| ---: | --- | --- | --- |
| 16 | small | 32-bit BMP + AND mask | 100% 标题栏 / 小图标 |
| 20 | small | 同上 | **125% 标题栏** |
| 24 | small | 同上 | 150% 小图标 |
| 32 | small | 同上 | 100% 任务栏 / 资源管理器 |
| 40 | small | 同上 | **125% 任务栏** |
| 48 | small | 同上 | 100% 中图标 |
| 64 | detail | 同上 | 125% 中图标（60→64） |
| 96 | detail | 同上 | 大图标 |
| 128 | detail | 同上 | 125% 大图标（120→128） |
| 256 | detail | 8-bit RGBA PNG | 超大图标 / 256+ 缩放 |

**A/B 结论（2026-10-20）**：40/48 也用小尺寸版。40px 是 125% 任务栏的物理尺寸，
small 变体明显更锐利；48 若换细节版会在 48→64 之间产生"细/粗"语言跳变。
证据图：`.verify/icon-final/ab/ab-40-48.png`、`.verify/icon-final/contact-sheet.png`
（`.verify/` 已 gitignore，证据只在本机）。

## 构建 / 验证

依赖：Python 3.11+、`cairosvg`（本机需 cairo 运行库）、`Pillow`、stdlib `zlib`。
**不新增任何 npm 依赖。**

```powershell
# 重新生成 icons/ 下全部 ICO + bundle PNG，并跑全量验证（失败 exit 1）
python -X utf8 modu/tests/tools/build-icons.py

# 只验证现有资产、重出证据图（不写 icons/）
python -X utf8 modu/tests/tools/build-icons.py --check
```

生成物（文件名/尺寸固定，`tauri.conf.json` 直接引用）：

- `icons/icon.ico`、`icons/file-icon.ico`：各 10 档（见上表）
- `icons/32x32.png`、`64x64.png`、`128x128.png`、`128x128@2x.png`、`icon.png`：
  细节版按原尺寸光栅化
- `icons/Square{30,44,71,89,107,142,150,284,310}Logo.png`、`StoreLogo.png`：
  细节版，文件名里的尺寸不变

## 格式与技术口径

- **直接按目标像素光栅化**（cairosvg `output_width/height=目标尺寸`），不做位图缩放。
- **≤128px 条目**：32-bit BMP —— `BITMAPINFOHEADER`(40B)、`biHeight=2h`、底向上 BGRA、
  后跟 AND mask（每行 4 字节对齐，**alpha==0 的像素掩码位置 1**）。
  `icon.ico` 10 档里 9 档 BMP 合计 148,568 B，这是本格式的硬下限。
- **256px 条目**：8-bit RGBA PNG（自写编码：filter 0 + zlib-9）。
  为了让 `icon.ico ≤ 150 KiB`（硬校验），PNG 的 **RGB 每通道四舍五入到 5 的倍数**
  （最大误差 2/255 ≈ 0.8%，alpha 不动）；原尺寸/×3 放大对比无可见差异
  （`.verify/icon-final/ab/quant-256-check.png`）。想完全无损可把
  `build-icons.py` 的 `PNG_ENTRY_RGB_STEP` 改回 `1`，代价是 `icon.ico` 约 150.9 KiB。
- 所有条目都是 32bpp、圆角外 alpha=0（透明角不是黑角/白边）。
- **16px 可辨性判据**（脚本自动断言，非目测）：外框四边可见、左右各一列 ≥10px 的
  竖笔（M 两竖）、至少一行墨迹段数 ≥4（中缝不糊死）、墨迹/纸面像素数在区间内。

## 复现与已知风险

- 像素结果确定，但**字节级复现依赖 cairosvg / Pillow / zlib 版本**；换版本重建可能
  体积 ±几字节（`icon.ico` 预算余量约 450 B，`--check` 会读实际文件判体积）。
- **Explorer / 任务栏图标缓存**：重建或重装后 Windows 可能仍显示旧图标，需
  `ie4uinit.exe -show` 或重启 explorer 刷新；exe 内图标要等 Lead 的正式构建才会更新。
- `icon.icns` 未改动；`f2-*.svg` 为历史稿未入库构建链。
