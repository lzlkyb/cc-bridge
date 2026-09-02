#!/usr/bin/env python3
"""生成 Tauri NSIS 安装向导页所需的位图（header / sidebar）。

NSIS MUI2 只认 BMP（不支持 PNG），且尺寸固定：
  - headerImage  : 150 x 57   显示在「安装中 / 完成」等内部页的顶部
  - sidebarImage : 164 x 314  显示在「欢迎 / 完成」页的左侧

底纹取 cc-bridge 品牌色（见 design/ConnectHero-整体背景.html 的 --version-gradient）：
  #6366F1 → #4F46E5（紫蓝渐变）

换 logo 后重跑本脚本即可：
    python tools/gen_nsis_bitmaps.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

# 品牌色（#6366F1 → #4F46E5），与前端 --version-gradient 保持一致
INDIGO_LIGHT = (99, 102, 241)
INDIGO_DARK = (79, 70, 229)
INDIGO_DEEP = (55, 48, 163)  # #3730A3，sidebar 竖向渐变的收尾色

SRC_ICON = Path(__file__).resolve().parent.parent / "desktop/src-tauri/icons/icon.png"
OUT_DIR = Path(__file__).resolve().parent.parent / "desktop/src-tauri/icons"


def gradient(size: tuple[int, int], start: tuple[int, int, int], end: tuple[int, int, int],
             horizontal: bool = False) -> Image.Image:
    """线性渐变背景。horizontal=True 时从左往右渐变，否则从上往下。"""
    w, h = size
    img = Image.new("RGB", (w, h))
    draw = ImageDraw.Draw(img)
    length = w if horizontal else h
    span = max(length - 1, 1)
    for i in range(length):
        t = i / span
        c = tuple(int(start[k] + (end[k] - start[k]) * t) for k in range(3))
        if horizontal:
            draw.line([(i, 0), (i, h)], fill=c)
        else:
            draw.line([(0, i), (w, i)], fill=c)
    return img


def paste_logo(bg: Image.Image, logo: Image.Image, size: int, x: int, y: int) -> None:
    """把 logo 按 alpha 通道合成到背景上。"""
    bg.paste(logo.resize((size, size), Image.LANCZOS), (x, y), logo.resize((size, size), Image.LANCZOS))


def main() -> None:
    logo = Image.open(SRC_ICON).convert("RGBA")

    # header: 150x57，横向渐变，logo 靠右
    header = gradient((150, 57), INDIGO_LIGHT, INDIGO_DARK, horizontal=True)
    logo_px = 42
    paste_logo(header, logo, logo_px, 150 - logo_px - 9, (57 - logo_px) // 2)
    header.save(OUT_DIR / "nsis-header.bmp", "BMP")

    # sidebar: 164x314，竖向渐变，logo 居中偏上
    sidebar = gradient((164, 314), INDIGO_LIGHT, INDIGO_DEEP)
    logo_px = 100
    paste_logo(sidebar, logo, logo_px, (164 - logo_px) // 2, 54)
    sidebar.save(OUT_DIR / "nsis-sidebar.bmp", "BMP")

    for name in ("nsis-header.bmp", "nsis-sidebar.bmp"):
        out = OUT_DIR / name
        with Image.open(out) as im:
            print(f"{name}: {im.size} {im.mode}  {out.stat().st_size} bytes")


if __name__ == "__main__":
    main()
