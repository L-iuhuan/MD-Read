# MoDu 图标资产（icons-src → icons）生成口径

本目录是 Windows 图标的**唯一矢量源**；`../icons/` 下的 `.ico` / `.png` 由
`modu/tests/tools/build-icons.py` 从这里的 SVG 光栅化得到，**不要手工改位图**。
`icon.icns`（仅 macOS）不参与本流程，保持原样。

> ⚠ **2026-10-20 用户裁定**：图标**视觉语言只有一个**（已批准的纸页 + M↓ + 朱砂书签）。
> 当年实验用的小尺寸变体（`f1-app-small.svg` / `f1-file-small.svg`，平涂粗框大 M）
> **是用户此前已否决的方向，已删除，不要再加回来**。图标"糊"的修复只允许：
> ① 补齐 Windows 实际请求的尺寸档（20 / 40 / 96 等）；② 每档按目标像素**直接光栅化**
> （不做位图缩放）。**不要用换一套小尺寸画法来"解决"清晰度。**

## 文件

| 文件 | 用途 | 视觉语言 |
| --- | --- | --- |
| `f1-app.svg` | **app 图标，全部 10 档** | 纸页、折角、朱砂书签、M↓（带柔和投影/渐变） |
| `f1-file.svg` | **`.md` 文件图标，全部 10 档** | 同上，无投影、M 略粗 |
| `f2-app.svg` / `f2-file.svg` | 历史方向稿，**不参与构建** | — |

品牌三元素在两个参与构建的文件里一致：**纸页 + M↓ + 朱砂书签**。

## 尺寸集合（为什么需要 10 档）

Windows 按物理像素挑图标；125% 缩放下任务栏 32 逻辑 → **40 物理**、
标题栏 16 逻辑 → **20 物理**。旧 ICO 只有 16/24/32/48/64/128/256（7 档），
缺 20/40 ⇒ 只能拿邻近尺寸缩放 ⇒ 糊；本次补到 10 档，且每档都从 SVG 按目标像素
重新光栅化（不是把 256 位图缩小）。

| 像素 | ICO 条目格式 | 典型使用场景 |
| ---: | --- | --- |
| 16 | 32-bit BMP + AND mask | 100% 标题栏 / 小图标 |
| 20 | 同上 | **125% 标题栏** |
| 24 | 同上 | 150% 小图标 |
| 32 | 同上 | 100% 任务栏 / 资源管理器 |
| 40 | 同上 | **125% 任务栏** |
| 48 | 同上 | 100% 中图标 |
| 64 | 同上 | 125% 中图标（60→64） |
| 96 | 同上 | 大图标 |
| 128 | 同上 | 125% 大图标（120→128） |
| 256 | 8-bit RGBA PNG | 超大图标 / 256+ 缩放 |

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
- **256px 条目**：8-bit RGBA PNG（filter 0 + zlib-9）；RGB 每通道量化到 5 的倍数
  （最大误差 2/255，肉眼不可见），控制 ICO 体积。想完全无损可把
  `build-icons.py` 的 `PNG_ENTRY_RGB_STEP` 改回 1。
- 所有条目都是 32bpp、圆角外 alpha=0（透明角不是黑角/白边）。
- **16px 可辨性判据**（脚本自动断言，非目测；针对已批准的纸页稿校准）：
  M 左右两根竖笔各≥6 像素高、至少一行墨迹段数≥3（中缝未糊死）、亮纸面留白≥60 像素、
  深墨像素在 [18,90] 区间。

## 复现与已知风险

- 像素结果确定，但**字节级复现依赖 cairosvg / Pillow / zlib 版本**；换版本重建可能
  体积 ±几字节（`--check` 会读实际文件判体积，预算 200KiB）。
- **Explorer / 任务栏图标缓存**：重建或重装后 Windows 可能仍显示旧图标，需
  `ie4uinit.exe -show` 或重启 explorer 刷新；exe 内图标要等正式构建（`pnpm tauri build`）才会更新。
- `icon.icns` 未改动；`f2-*.svg` 为历史稿未入库构建链。
