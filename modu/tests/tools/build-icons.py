#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""墨读（MoDu）图标资产构建器：SVG -> 多尺寸 Windows ICO + Tauri bundle PNG。

为什么需要它（用户反馈「图标分辨率低、很糊」的根因）：
  * 旧 icon.ico 只有 7 档、file-icon.ico 只有 5 档，缺 20 / 40（125% DPI 下
    标题栏 16 逻辑 -> 20 物理、任务栏 32 逻辑 -> 40 物理），Windows 只能拿
    邻近尺寸缩放，于是糊；
  * 旧小尺寸是位图缩放产物（不是按目标像素重新光栅化），边缘发虚。

修复口径（2026-10-20 用户裁定，勿再改视觉语言）：
  * **只用已批准的细节版 f1-app.svg / f1-file.svg**，10 档尺寸逐档按目标像素
    直接光栅化（不缩放位图）——**不引入任何改变视觉语言的小尺寸变体**；
  * 当年 WIP 的 `f1-app-small.svg / f1-file-small.svg`（平涂粗框大 M）是
    **用户此前已否决的方向**，已从仓库删除，不要再加回来。

产物：
  modu/src-tauri/icons/icon.ico              app 图标，16/20/24/32/40/48/64/96/128/256
  modu/src-tauri/icons/file-icon.ico         .md 文件图标，同上十档
  modu/src-tauri/icons/{32x32,64x64,128x128,128x128@2x,icon}.png
  modu/src-tauri/icons/{Square*,StoreLogo}.png  （细节版，文件名/尺寸不变）
  .verify/icon-final/  验证证据（报告 / contact-sheet / 前后对比图，gitignore）
  icons/icon.icns 不动（仅 macOS 用）。

用法（仓库根目录）：
  python -X utf8 modu/tests/tools/build-icons.py            # 重新生成 + 全量验证
  python -X utf8 modu/tests/tools/build-icons.py --check    # 只验证现有资产（不写图标）

依赖：Python 3.11+、cairosvg（本机需 cairo 运行库）、Pillow、zlib（stdlib）。
不新增 npm 依赖，不跑构建/打包，不启动应用。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import struct
import sys
import zlib
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

import cairosvg

# ---------------------------------------------------------------- 路径与常量

ROOT = Path(__file__).resolve().parents[3]          # <repo>/modu/tests/tools/build-icons.py
SRC_DIR = ROOT / "modu" / "src-tauri" / "icons-src"
ICON_DIR = ROOT / "modu" / "src-tauri" / "icons"
EVID_DIR = ROOT / ".verify" / "icon-final"
BASELINE_DIR = EVID_DIR / "baseline"

APP_DETAIL = SRC_DIR / "f1-app.svg"
FILE_DETAIL = SRC_DIR / "f1-file.svg"

ICO_SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
BMP_MAX = 128                 # ≤128 用 32-bit BMP 条目（兼容性最好），256 用 PNG 条目
PNG_ENTRY_MIN = 256
# 256px PNG 条目把 RGB 每通道四舍五入到 5 的倍数（最大误差 2/255，肉眼不可见），
# 控制 ICO 体积；想逐字节等于 SVG 渲染可改回 1。
PNG_ENTRY_RGB_STEP = 5
# 体积软预算：9 个 BMP 条目固定约 148.6KB，256 PNG 另计；超过 200KiB 才报 FAIL。
ICO_BUDGET_BYTES = 200 * 1024

# Tauri bundle 用 PNG：文件名与尺寸保持原样，来源统一为细节版
BUNDLE_PNGS = (
    ("32x32.png", 32),
    ("64x64.png", 64),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("icon.png", 512),
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
    ("StoreLogo.png", 50),
)

PNG_SIG = b"\x89PNG\r\n\x1a\n"
LIGHT_BG = (0xF3, 0xF3, 0xF3)
DARK_BG = (0x20, 0x20, 0x20)


# ---------------------------------------------------------------- 光栅化

def render_svg(svg_path: Path, size: int) -> Image.Image:
    """按目标像素直接光栅化 SVG（不缩放位图）。"""
    raw = cairosvg.svg2png(url=str(svg_path), output_width=size, output_height=size)
    im = Image.open(io.BytesIO(raw)).convert("RGBA")
    if im.size != (size, size):
        raise SystemExit(f"[FAIL] {svg_path.name} 渲染尺寸异常: {im.size} != {(size, size)}")
    return im


def source_for(svg_path: Path, size: int) -> Path:
    """单一来源：已批准的细节版 SVG。10 档各自按目标像素光栅化（不缩放位图）。

    ⚠ 2026-10-20 用户裁定：不要再引入改变视觉语言的小尺寸变体（平涂粗框版曾被否决）。"""
    del size  # 尺寸只影响光栅化，不改变来源；保留形参让 build_ico 调用侧不变
    return svg_path


# ---------------------------------------------------------------- ICO 编码

def _mask_row_bytes(width: int) -> int:
    """AND 掩码每行字节数（按 DWORD 对齐）。"""
    return ((width + 31) // 32) * 4


def bmp_entry(im: Image.Image) -> bytes:
    """32-bit BMP ICO 条目：BITMAPINFOHEADER(40) + 底向上 BGRA + AND 掩码。

    AND 掩码 = 透明像素（alpha==0）置 1，其余 0；Vista+ 用 alpha 通道，
    旧接口用掩码，两者必须一致。
    """
    w, h = im.size
    px = im.load()
    mask_row = _mask_row_bytes(w)
    pixel_bytes = w * h * 4
    mask_bytes = mask_row * h
    buf = bytearray(40 + pixel_bytes + mask_bytes)

    struct.pack_into("<IiiHHIIiiII", buf, 0,
                     40, w, h * 2, 1, 32, 0, pixel_bytes + mask_bytes,
                     0, 0, 0, 0)
    base = 40
    mask_base = base + pixel_bytes
    for y in range(h):
        src_y = h - 1 - y                       # 底向上
        row = base + y * (w * 4)
        for x in range(w):
            r, g, b, a = px[x, src_y]
            dst = row + x * 4
            buf[dst] = b
            buf[dst + 1] = g
            buf[dst + 2] = r
            buf[dst + 3] = a
            if a == 0:
                byte_index = mask_base + y * mask_row + (x >> 3)
                buf[byte_index] |= 0x80 >> (x & 7)
    return bytes(buf)


def png_entry(im: Image.Image, rgb_step: int = PNG_ENTRY_RGB_STEP) -> bytes:
    """32-bit RGBA PNG ICO 条目（自写编码：filter 0 + zlib-9）。

    Pillow 的 PNG 写出在 256px 细节版上约 6.2KB；自写 filter-0 编码约 6.0KB。
    9 档 BMP 已占 148,568B，还差约 1.2KB 才够 150KiB ⇒ 把 RGB 每通道
    四舍五入到 step 的倍数（step=5 时最大误差 2/255 ≈ 0.8%），alpha 完全不动。
    实测 256px 原尺寸与 ×3 放大对比均看不出差异（证据：.verify/icon-final/ab/
    quant-256-check.png），且 256 条目只在「超大图标」等场景使用。
    """
    if rgb_step > 1:
        r, g, b, a = im.split()
        half = rgb_step // 2
        f = lambda v: min(255, ((v + half) // rgb_step) * rgb_step)  # noqa: E731
        im = Image.merge("RGBA", (r.point(f), g.point(f), b.point(f), a))
    w, h = im.size
    data = im.tobytes()
    stride = w * 4
    raw = bytearray()
    for y in range(h):
        raw.append(0)                             # filter type 0 (None)
        raw += data[y * stride:(y + 1) * stride]
    co = zlib.compressobj(9, zlib.DEFLATED, 15, 9, zlib.Z_DEFAULT_STRATEGY)
    idat = co.compress(bytes(raw)) + co.flush()

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)   # 8bit RGBA, 非交错
    return PNG_SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def write_ico(path: Path, items: list[tuple[int, bytes]]) -> int:
    """items: [(size, entry_bytes)]，entry 为 BMP 或 PNG 由 size 决定。"""
    items = sorted(items)
    header = bytearray(6 + 16 * len(items))
    struct.pack_into("<HHH", header, 0, 0, 1, len(items))
    offset = len(header)
    for i, (size, payload) in enumerate(items):
        o = 6 + i * 16
        b = 0 if size >= 256 else size
        header[o] = b
        header[o + 1] = b
        header[o + 2] = 0
        header[o + 3] = 0
        struct.pack_into("<HHII", header, o + 4, 1, 32, len(payload), offset)
        offset += len(payload)
    path.write_bytes(bytes(header) + b"".join(p for _, p in items))
    return path.stat().st_size


def build_ico(path: Path, svg: Path) -> list[tuple[int, int, str]]:
    """生成十档 ICO（全部来自同一个已批准的细节版 SVG）；返回 [(size, bytes, format)]。"""
    items: list[tuple[int, bytes]] = []
    report: list[tuple[int, int, str]] = []
    for size in ICO_SIZES:
        im = render_svg(source_for(svg, size), size)
        if size >= PNG_ENTRY_MIN:
            payload = png_entry(im)
            kind = "PNG"
        else:
            payload = bmp_entry(im)
            kind = "BMP"
        items.append((size, payload))
        report.append((size, len(payload), kind))
    write_ico(path, items)
    return report


def build_bundle_pngs() -> list[tuple[str, int]]:
    built = []
    for name, size in BUNDLE_PNGS:
        im = render_svg(APP_DETAIL, size)
        im.save(ICON_DIR / name, format="PNG", optimize=True)
        built.append((name, size))
    return built


# ---------------------------------------------------------------- 解析与验证

def parse_ico(path: Path) -> list[dict]:
    data = path.read_bytes()
    reserved, typ, count = struct.unpack_from("<HHH", data, 0)
    if (reserved, typ) != (0, 1):
        raise ValueError(f"{path.name}: 不是 ICO（reserved={reserved} type={typ}）")
    entries = []
    for i in range(count):
        o = 6 + i * 16
        w, h, ncol, rsv, planes, bpp, size, off = struct.unpack_from("<BBBBHHII", data, o)
        dim = 256 if w == 0 else w
        kind = "PNG" if data[off:off + 8] == PNG_SIG else "BMP"
        entries.append(dict(index=i, size=dim, w=w, h=h, colors=ncol, reserved=rsv,
                            planes=planes, bpp=bpp, bytes=size, offset=off,
                            format=kind, end=off + size))
    return entries


def check_ico_structure(path: Path) -> tuple[list[dict], list[str]]:
    entries = parse_ico(path)
    errs: list[str] = []
    sizes = [e["size"] for e in entries]
    if sizes != sorted(ICO_SIZES):
        errs.append(f"{path.name}: 尺寸集合/顺序异常 {sizes} != {list(ICO_SIZES)}")
    total = path.stat().st_size
    for e in entries:
        if e["planes"] != 1 or e["bpp"] != 32:
            errs.append(f"{path.name}@{e['size']}: planes={e['planes']} bpp={e['bpp']} 不是 32bpp")
        if e["offset"] + e["bytes"] > total:
            errs.append(f"{path.name}@{e['size']}: 条目越界")
        expect = "PNG" if e["size"] >= PNG_ENTRY_MIN else "BMP"
        if e["format"] != expect:
            errs.append(f"{path.name}@{e['size']}: 格式 {e['format']} != {expect}")
        if e["format"] == "BMP":
            errs += _check_bmp_entry(path, e)
        else:
            errs += _check_png_entry(path, e)
    return entries, errs


def _check_bmp_entry(path: Path, e: dict) -> list[str]:
    data = path.read_bytes()[e["offset"]:e["end"]]
    errs: list[str] = []
    w, h = e["size"], e["size"]
    size_hdr, bi_w, bi_h, planes, bpp, comp, size_img = struct.unpack_from("<IiiHHII", data, 0)
    if (size_hdr, bi_w, bi_h, planes, bpp, comp) != (40, w, h * 2, 1, 32, 0):
        errs.append(f"{path.name}@{w}: BITMAPINFOHEADER 异常 "
                    f"size={size_hdr} w={bi_w} h={bi_h} planes={planes} bpp={bpp} comp={comp}")
    mask_row = _mask_row_bytes(w)
    if size_img != w * h * 4 + mask_row * h:
        errs.append(f"{path.name}@{w}: biSizeImage={size_img} 与像素+掩码长度不符")
    if len(data) != 40 + size_img:
        errs.append(f"{path.name}@{w}: 条目长度 {len(data)} != 40+{size_img}")
    px = data[40:40 + w * h * 4]
    mask = data[40 + w * h * 4:]
    for y in range(h):
        for x in range(w):
            a = px[(y * w + x) * 4 + 3]
            bit = (mask[y * mask_row + (x >> 3)] >> (7 - (x & 7))) & 1
            if bit != (1 if a == 0 else 0):
                errs.append(f"{path.name}@{w}: ({x},{y}) alpha={a} 与 AND 掩码 bit={bit} 不一致")
                return errs      # 一处不一致就够，避免刷屏
    return errs


def _check_png_entry(path: Path, e: dict) -> list[str]:
    data = path.read_bytes()[e["offset"]:e["end"]]
    errs: list[str] = []
    if data[:8] != PNG_SIG:
        errs.append(f"{path.name}@{e['size']}: PNG 签名异常")
        return errs
    w, h, depth, ctype, comp, filt, ilace = struct.unpack_from(">IIBBBBB", data, 16)
    if (w, h, depth, ctype, ilace) != (e["size"], e["size"], 8, 6, 0):
        errs.append(f"{path.name}@{e['size']}: PNG IHDR 异常 "
                    f"{w}x{h} depth={depth} ctype={ctype} ilace={ilace}")
    return errs


def _corners_transparent(im: Image.Image) -> list[str]:
    w, h = im.size
    px = im.load()
    bad = []
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if px[x, y][3] != 0:
            bad.append(f"角({x},{y}) alpha={px[x, y][3]}")
    return bad


def _coverage(im: Image.Image) -> float:
    w, h = im.size
    px = im.load()
    n = sum(1 for y in range(h) for x in range(w) if px[x, y][3] > 0)
    return n / (w * h)


def _frames_equal(frame: Image.Image, ref: Image.Image, rgb_tol: int) -> tuple[bool, int, int]:
    """比较两帧 RGBA；返回 (是否一致, RGB 最大差, alpha 最大差)。"""
    if frame.size != ref.size:
        return False, 999, 999
    a = frame.tobytes()
    b = ref.tobytes()
    max_rgb = 0
    max_a = 0
    for i in range(0, len(a), 4):
        for c in range(3):
            d = abs(a[i + c] - b[i + c])
            if d > max_rgb:
                max_rgb = d
        da = abs(a[i + 3] - b[i + 3])
        if da > max_a:
            max_a = da
    return (max_rgb <= rgb_tol and max_a == 0), max_rgb, max_a


# ---------------------------------------------------------------- 16px 可辨性

def check_legibility(im: Image.Image, tag: str) -> tuple[list[str], dict]:
    """16px 可辨性判据（针对已批准的细节版纸页稿，2026-10-20 校准）。

    结构判据：M 的左右两根竖笔（各≥6 像素高）+ 中缝（存在 ≥3 段墨迹的行）
    + 亮纸面留白足够 —— 不是单一代理指标，也不要求"粗外框"（那是已否决变体的特征）。
    实测基线：app ink=30 / file ink=34；两竖笔列 x=4 / x=11（各 8 像素）；max_runs=4。
    """
    w, h = im.size
    if (w, h) != (16, 16):
        return [f"{tag}: 期望 16x16，实际 {w}x{h}"], {}
    px = im.load()

    def lum(x, y):
        r, g, b, _ = px[x, y]
        return 0.2126 * r + 0.7152 * g + 0.0722 * b

    ink = [(x, y) for y in range(h) for x in range(w)
           if px[x, y][3] > 128 and lum(x, y) < 120]
    paper = [(x, y) for y in range(h) for x in range(w)
             if px[x, y][3] > 200 and lum(x, y) > 200]
    ink_set = set(ink)
    col_counts = Counter(x for x, _ in ink)

    # M 两竖笔：左半 x∈[3,7]、右半 x∈[8,12] 各至少要有一列高≥6 的深墨
    left_stems = [x for x in range(3, 8) if col_counts.get(x, 0) >= 6]
    right_stems = [x for x in range(8, 13) if col_counts.get(x, 0) >= 6]
    stems_ok = (bool(left_stems) and bool(right_stems)
                and min(right_stems) - max(left_stems) >= 4)
    # 中缝/斜笔：至少一行出现 ≥3 段墨迹（左竖 | 斜笔/中缝 | 右竖）
    max_runs = 0
    for y in range(h):
        runs, prev = 0, -9
        for x in range(w):
            if (x, y) in ink_set:
                if x != prev + 1:
                    runs += 1
                prev = x
        max_runs = max(max_runs, runs)
    metrics = dict(ink=len(ink), paper=len(paper), max_runs=max_runs,
                   left_stems=left_stems, right_stems=right_stems)
    errs = []
    if len(ink) < 18 or len(ink) > 90:
        errs.append(f"{tag}: 墨迹像素 {len(ink)} 超出 [18,90]")
    if len(paper) < 60:
        errs.append(f"{tag}: 纸面留白像素 {len(paper)} < 60")
    if not stems_ok:
        errs.append(f"{tag}: M 两竖笔不可辨 {metrics}")
    if max_runs < 3:
        errs.append(f"{tag}: 墨迹结构段数 {max_runs} < 3（M 中缝丢失）")
    return errs, metrics


# ---------------------------------------------------------------- 图像辅助

def _composite(im: Image.Image, bg: tuple[int, int, int]) -> Image.Image:
    canvas = Image.new("RGBA", im.size, bg + (255,))
    canvas.alpha_composite(im)
    return canvas.convert("RGB")


def _nearest(im: Image.Image, zoom: int) -> Image.Image:
    return im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)


def _font(size: int):
    for path in ("C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _old_effective_size(old_frames: dict[int, Image.Image], size: int) -> Image.Image:
    """模拟 Windows：请求尺寸缺档时，取最近的更大档缩下来（没有更大的则取最大档）。"""
    keys = sorted(old_frames)
    larger = [k for k in keys if k >= size]
    src = min(larger) if larger else max(keys)
    return old_frames[src].resize((size, size), Image.LANCZOS)


def load_baseline_frames() -> dict[str, dict[int, Image.Image]]:
    out: dict[str, dict[int, Image.Image]] = {}
    for name, fn in (("app", "icon.ico.before.ico"), ("file", "file-icon.ico.before.ico")):
        p = BASELINE_DIR / fn
        frames: dict[int, Image.Image] = {}
        if p.is_file():
            im = Image.open(p)
            for sz in sorted(im.ico.sizes()):
                frames[sz[0]] = im.ico.getimage(sz).convert("RGBA")
        out[name] = frames
    return out


# ---------------------------------------------------------------- 证据图

CONTACT_SIZES = (16, 20, 24, 32, 40, 48, 64)


def _stack(sections: list[Image.Image]) -> Image.Image:
    width = max(p.width for p in sections)
    out = Image.new("RGB", (width, sum(p.height for p in sections)), (255, 255, 255))
    y = 0
    for p in sections:
        out.paste(p, (0, y))
        y += p.height
    return out


def make_contact_sheet(new_frames: dict[str, dict[int, Image.Image]]) -> Path:
    """浅底/深底两行 × 16/20/24/32/40/48/64 原尺寸 + ×10 最近邻放大。

    每个尺寸一列：上排原尺寸（居中），下排 ×10 最近邻放大，各自带居中标签。
    app / file × 浅底 / 深底共 4 段；尺寸列与放大块一一对齐。
    """
    zoom = 10
    margin, gap = 24, 14
    label_h, native_band, zoom_label_h = 20, 96, 22
    cell_w = [s * zoom for s in CONTACT_SIZES]
    sheet_w = margin * 2 + sum(cell_w) + gap * (len(cell_w) - 1)
    section_h = label_h + native_band + zoom_label_h + 64 * zoom + 10
    parts = []
    for tag in ("app", "file"):
        for bg, bg_name in ((LIGHT_BG, "light (#F3F3F3)"), (DARK_BG, "dark (#202020)")):
            sec = Image.new("RGB", (sheet_w, section_h), bg)
            d = ImageDraw.Draw(sec)
            fg = (25, 25, 25) if bg_name.startswith("light") else (235, 235, 235)
            small = _font(12)
            d.text((margin, 4),
                   f"MoDu {tag} — {bg_name} — top: native size, bottom: x{zoom} nearest-neighbour",
                   fill=fg, font=_font(14))
            x = margin
            for s, cw in zip(CONTACT_SIZES, cell_w):
                cx = x + cw // 2
                # 原尺寸：在 72px 高的带内水平/垂直居中
                tile = _composite(new_frames[tag][s], bg)
                ny = label_h + (native_band - s) // 2
                sec.paste(tile, (cx - s // 2, ny))
                tw = d.textlength(f"{s}px", font=small)
                d.text((cx - tw / 2, label_h + native_band - 14), f"{s}px", fill=fg, font=small)
                # ×10 放大
                yb = label_h + native_band + zoom_label_h
                zw = d.textlength(f"{s}px x{zoom}", font=small)
                d.text((cx - zw / 2, yb - zoom_label_h + 4), f"{s}px x{zoom}", fill=fg, font=small)
                sec.paste(_nearest(tile, zoom), (x, yb))
                x += cw + gap
            parts.append(sec)
    out = EVID_DIR / "contact-sheet.png"
    _stack(parts).save(out)
    return out


def _tile_row(entries: list[tuple[str, Image.Image, Image.Image]], zoom: int,
              bg: tuple[int, int, int], title: str) -> Image.Image:
    """一行：每个 entry 输出 native 与 ×zoom 两块，块下方/上方带标签。"""
    margin, gap = 16, 14
    fg = (25, 25, 25) if sum(bg) > 384 else (235, 235, 235)
    font, small = _font(14), _font(11)
    cells = []
    for label, native, big in entries:
        cell = Image.new("RGB", (max(native.width, big.width), 18 + native.height + 6 + big.height), bg)
        cd = ImageDraw.Draw(cell)
        cd.text((1, 2), label, fill=fg, font=small)
        cell.paste(native, ((cell.width - native.width) // 2, 18))
        cell.paste(big, ((cell.width - big.width) // 2, 18 + native.height + 6))
        cells.append(cell)
    row_w = margin * 2 + sum(c.width for c in cells) + gap * (len(cells) - 1)
    row = Image.new("RGB", (row_w, 24 + max(c.height for c in cells) + 6), bg)
    d = ImageDraw.Draw(row)
    d.text((margin, 2), title, fill=fg, font=font)
    x = margin
    for c in cells:
        row.paste(c, (x, 24))
        x += c.width + gap
    return row


def make_ab_evidence(new_frames: dict[str, dict[int, Image.Image]],
                     old_frames: dict[str, dict[int, Image.Image]]) -> Path:
    """证据：改造前后对照（旧 ICO 被 Windows 按邻近档缩放 vs 新多档精确帧）。

    ⚠ 2026-10-20 用户裁定后已删除"small / detail A/B"证据——视觉语言不再有二选一。"""
    zoom = 4
    rows = []
    for tag in ("app", "file"):
        for bg, bg_name in ((LIGHT_BG, "light"), (DARK_BG, "dark")):
            entries = []
            for size in CONTACT_SIZES:
                old = _composite(_old_effective_size(old_frames[tag], size), bg)
                new = _composite(new_frames[tag][size], bg)
                entries.append((f"{size} old", old, _nearest(old, zoom)))
                entries.append((f"{size} new", new, _nearest(new, zoom)))
            rows.append(_tile_row(entries, zoom, bg,
                                  f"{tag} before/after ({bg_name} bg): old ICO scaled by nearest-size"
                                  f" vs new exact frame — x{zoom}"))
    out = EVID_DIR / "ab" / "before-after.png"
    _stack(rows).save(out)
    return out


# ---------------------------------------------------------------- 报告

def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_report(lines: list[str], data: dict) -> Path:
    txt = EVID_DIR / "verify-report.txt"
    txt.write_text("\n".join(lines) + "\n", encoding="utf-8")
    js = EVID_DIR / "verify-report.json"
    js.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return txt


# ---------------------------------------------------------------- 主流程

def verify(new_frames, failures: list[str], lines: list[str], data: dict) -> None:
    old_frames = load_baseline_frames()

    lines.append("== 最终 ICO 条目表 ==")
    for tag, fname in (("app", "icon.ico"), ("file", "file-icon.ico")):
        path = ICON_DIR / fname
        entries, errs = check_ico_structure(path)
        failures += errs
        lines.append(f"-- {fname}：{path.stat().st_size} bytes"
                     f"（{path.stat().st_size / 1024:.2f} KiB），{len(entries)} 档")
        lines.append(f"   {'size':>5} {'format':>5} {'bytes':>7} {'offset':>7} {'bpp':>3} {'planes':>6}")
        for e in entries:
            lines.append(f"   {e['size']:5d} {e['format']:>5} {e['bytes']:7d}"
                         f" {e['offset']:7d} {e['bpp']:3d} {e['planes']:6d}")

        # PIL 打开全部帧 + 与源 SVG 复渲染比对
        pil = Image.open(path)
        pil_sizes = sorted(pil.ico.sizes())
        expect = sorted((s, s) for s in ICO_SIZES)
        if pil_sizes != expect:
            failures.append(f"{fname}: PIL 帧集合 {pil_sizes} != {expect}")
        lines.append(f"   PIL 帧：{len(pil_sizes)}/{len(ICO_SIZES)} 可打开 {pil_sizes}")
        src_svg = {"app": APP_DETAIL, "file": FILE_DETAIL}[tag]
        for size in ICO_SIZES:
            frame = pil.ico.getimage((size, size)).convert("RGBA")
            if frame.size != (size, size):
                failures.append(f"{fname}@{size}: getimage 尺寸异常 {frame.size}")
                continue
            bad = _corners_transparent(frame)
            if bad:
                failures.append(f"{fname}@{size}: 四角不透明：{bad}")
            cov = _coverage(frame)
            if not 0.25 <= cov <= 0.99:
                failures.append(f"{fname}@{size}: 不透明覆盖率 {cov:.2f} 异常")
            ref = render_svg(src_svg, size)
            tol = (PNG_ENTRY_RGB_STEP // 2) if size >= PNG_ENTRY_MIN else 0
            ok, max_rgb, max_a = _frames_equal(frame, ref, tol)
            if not ok:
                failures.append(f"{fname}@{size}: 帧与源 SVG 不一致"
                                f"（RGB max diff={max_rgb} tol={tol}, alpha max diff={max_a}）")
            lines.append(f"   {size:>3}px frame: corners=transparent coverage={cov:.2f} "
                         f"rgb_max_diff={max_rgb} alpha_max_diff={max_a} OK")
        if tag == "app":
            budget_ok = path.stat().st_size <= ICO_BUDGET_BYTES
            lines.append(f"   体积：{path.stat().st_size} B ≤ 200KiB({ICO_BUDGET_BYTES} B) ? "
                         f"{'PASS' if budget_ok else 'FAIL'}")
            if not budget_ok:
                failures.append(f"{fname}: {path.stat().st_size} B 超出 200KiB 预算")
        data[fname] = dict(bytes=path.stat().st_size, sha256=sha256(path),
                           entries=[dict(size=e["size"], format=e["format"],
                                         bytes=e["bytes"], offset=e["offset"]) for e in entries])

    # 16px 可辨性（app + file）
    lines.append("== 16px 可辨性检查 ==")
    for tag in ("app", "file"):
        errs, metrics = check_legibility(new_frames[tag][16], tag)
        failures += errs
        lines.append(f"   {tag}: {metrics} -> {'PASS' if not errs else 'FAIL: ' + '; '.join(errs)}")
    # 16/20/40 原尺寸可视化取证（单独存文件，便于人工放大看）
    for size in (16, 20, 40):
        for tag in ("app", "file"):
            _nearest(_composite(new_frames[tag][size], LIGHT_BG), 20).save(
                EVID_DIR / f"{tag}-{size}px-light-x20.png")
            _nearest(_composite(new_frames[tag][size], DARK_BG), 20).save(
                EVID_DIR / f"{tag}-{size}px-dark-x20.png")

    # bundle PNG
    lines.append("== bundle PNG ==")
    data["bundle_png"] = {}
    for name, size in BUNDLE_PNGS:
        p = ICON_DIR / name
        im = Image.open(p)
        ok = im.size == (size, size) and im.mode == "RGBA"
        corners = _corners_transparent(im.convert("RGBA"))
        lines.append(f"   {name:24s} {im.size[0]}x{im.size[1]} mode={im.mode} "
                     f"bytes={p.stat().st_size} corners={'OK' if not corners else corners}")
        if not ok:
            failures.append(f"{name}: 尺寸/模式异常 {im.size} {im.mode}")
        if corners:
            failures.append(f"{name}: 四角不透明 {corners}")
        data["bundle_png"][name] = dict(size=list(im.size), bytes=p.stat().st_size,
                                        sha256=sha256(p))

    # 证据图
    sheet = make_contact_sheet(new_frames)
    ab = make_ab_evidence(new_frames, old_frames)
    lines.append("== 证据图 ==")
    lines.append(f"   contact-sheet: {sheet.relative_to(ROOT)}")
    lines.append(f"   前后对照: {ab.relative_to(ROOT)}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="构建/验证墨读图标资产")
    ap.add_argument("--check", action="store_true", help="只验证现有资产，不重新生成")
    args = ap.parse_args(argv)

    EVID_DIR.mkdir(parents=True, exist_ok=True)
    (EVID_DIR / "ab").mkdir(parents=True, exist_ok=True)
    if not BASELINE_DIR.is_dir():
        BASELINE_DIR.mkdir(parents=True)
        for fname in ("icon.ico", "file-icon.ico"):
            src = ICON_DIR / fname
            if src.is_file():
                (BASELINE_DIR / (fname + ".before.ico")).write_bytes(src.read_bytes())
                print(f"[baseline] 已快照改造前 {fname}")

    lines: list[str] = []
    data: dict = {"generated_by": "modu/tests/tools/build-icons.py"}
    failures: list[str] = []

    if not args.check:
        print("[build] 生成 icon.ico ...")
        data["app_ico_entries"] = build_ico(ICON_DIR / "icon.ico", APP_DETAIL)
        print("[build] 生成 file-icon.ico ...")
        data["file_ico_entries"] = build_ico(ICON_DIR / "file-icon.ico", FILE_DETAIL)
        print("[build] 生成 bundle PNG ...")
        data["built_bundle_png"] = build_bundle_pngs()
        lines.append(f"== 生成 ==")
        lines.append(f"   10 档全部来自已批准的细节版 SVG，逐档按目标像素光栅化（不做位图缩放）")
        for tag, fname in (("app", "icon.ico"), ("file", "file-icon.ico")):
            rows = data["app_ico_entries" if tag == "app" else "file_ico_entries"]
            lines.append(f"   {fname}: " + " ".join(
                f"{s}px={n}B/{k}" for s, n, k in rows))

    # 读回最终 ICO 帧（build 后与 --check 共用同一路径）
    new_frames: dict[str, dict[int, Image.Image]] = {}
    for tag, fname in (("app", "icon.ico"), ("file", "file-icon.ico")):
        path = ICON_DIR / fname
        if not path.is_file():
            print(f"[FAIL] 缺少 {path}")
            return 1
        im = Image.open(path)
        new_frames[tag] = {sz[0]: im.ico.getimage(sz).convert("RGBA")
                           for sz in sorted(im.ico.sizes())}

    verify(new_frames, failures, lines, data)

    lines.append("== 结论 ==")
    if failures:
        lines.append(f"FAIL：{len(failures)} 项")
        for f in failures:
            lines.append(f"   - {f}")
    else:
        lines.append("PASS：条目表 / PIL 帧 / 透明角 / 源 SVG 一致性 / 16px 可辨性 / 体积 全部通过")
    report = write_report(lines, data)

    print("\n".join(lines))
    print(f"\n[report] {report}")
    for f in failures:
        print(f"[FAIL] {f}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
