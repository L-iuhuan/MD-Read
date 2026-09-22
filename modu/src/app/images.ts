/**
 * 相对路径图片解析（P5 批1·P0 #5）。alpha 实锤：管线输出的 <img src="./pic.png">
 * 是相对 md 文件的路径，WebView 无文件系统基准 → 必 404。此处按文档所在目录拼成
 * 绝对路径，经 convertFileSrc 转 asset 协议后赋回 src。CSP img-src 已含
 * asset: 与 http://asset.localhost（tauri.conf.json），无需改动。
 * 接线（批2）：mountRendered 末尾调 resolveRelativeImages(doc, tab.path)。
 */
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * 纯函数：src 是否已是 WebView 可直接加载的形态
 * （远程 http/https、data 内嵌、asset 协议、blob）→ 无需转换。
 */
export function isDirectlyLoadable(src: string): boolean {
  return /^(https?:|data:|asset:|blob:)/i.test(src);
}

/**
 * 纯函数：文档路径 + 相对 src → 绝对路径。
 * 兼容 / 与 \ 两种分隔符；./ 段忽略；../ 逐级上弹（盘符段不可弹越，钳制在盘符）。
 * 例：joinRelativeToDoc("E:\\docs\\sub\\a.md", "../img/x.png") === "E:/docs/img/x.png"
 */
export function joinRelativeToDoc(docPath: string, relSrc: string): string {
  const sep = Math.max(docPath.lastIndexOf("/"), docPath.lastIndexOf("\\"));
  const dir = sep >= 0 ? docPath.slice(0, sep) : docPath;
  const base = dir.split(/[\\/]+/).filter((seg) => seg !== "");
  for (const seg of relSrc.split(/[\\/]+/)) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (base.length > 1) {
        base.pop();
      }
      continue;
    }
    base.push(seg);
  }
  return base.join("/");
}

/**
 * 容器内相对路径 img → asset 协议（幂等：data 标记，重复调用跳过已处理元素）。
 * 加载失败不替换元素，只补中文占位 title 提示使用者。
 */
export function resolveRelativeImages(container: HTMLElement, docPath: string): void {
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img[src]"))) {
    if (img.dataset.relResolved === "1") {
      continue;
    }
    img.dataset.relResolved = "1"; // 先标记：同一元素只处理一次，成败都不重来
    const raw = img.getAttribute("src") ?? "";
    if (raw === "" || isDirectlyLoadable(raw)) {
      continue;
    }
    img.src = convertFileSrc(joinRelativeToDoc(docPath, raw));
    img.addEventListener("error", () => {
      img.title = "图片加载失败：文件不存在或不可读";
    });
  }
}
