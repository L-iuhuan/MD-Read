/**
 * 相对路径图片解析（P5 批1·P0 #5；P0-3 补 asset scope 授权）。alpha 实锤：管线输出的
 * <img src="./pic.png"> 是相对 md 文件的路径，WebView 无文件系统基准 → 必 404。此处按
 * 文档所在目录拼成绝对路径，经 convertFileSrc 转 asset 协议后赋回 src。CSP img-src 已含
 * asset: 与 http://asset.localhost（tauri.conf.json），无需改动。
 * P0-3：assetProtocol 静态 scope 为空列表（无 `**` 全盘放行），故每个真实引用的文件必须
 * 先经 allow_asset_paths 加进运行时 scope，否则 asset 请求仍被拒。
 * 接线（批2）：mountRendered 末尾调 resolveRelativeImages(doc, tab.path)。
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** 图片加载失败时补的中文占位提示（invoke 失败与 error 事件共用同一文案）。 */
const LOAD_FAIL_TITLE = "图片加载失败：文件不存在或不可读";

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
 * 签名保持同步（调用点 main.ts 不改）：同步走完收集与标记，再异步授权 scope 后赋 src。
 */
export function resolveRelativeImages(container: HTMLElement, docPath: string): void {
  const pending: Array<{ img: HTMLImageElement; abs: string }> = [];
  for (const img of Array.from(container.querySelectorAll<HTMLImageElement>("img[src]"))) {
    if (img.dataset.relResolved === "1") {
      continue;
    }
    img.dataset.relResolved = "1"; // 先标记：同一元素只处理一次，成败都不重来
    const raw = img.getAttribute("src") ?? "";
    if (raw === "" || isDirectlyLoadable(raw)) {
      continue;
    }
    img.addEventListener("error", () => {
      img.title = LOAD_FAIL_TITLE;
    });
    pending.push({ img, abs: joinRelativeToDoc(docPath, raw) }); // src 待 scope 授权后再赋
  }
  if (pending.length === 0) {
    return;
  }
  const paths = pending.map((item) => item.abs);
  void invoke("allow_asset_paths", { paths })
    .then(() => {
      for (const { img, abs } of pending) {
        img.src = convertFileSrc(abs);
      }
    })
    .catch((error: unknown) => {
      // 授权失败不改 src（避免必然 404 的空转），按既有失败文案提示使用者；A4：错误本体只进 console
      console.error(`图片资源授权失败（${pending.length} 张，文档：${docPath}）`, error);
      for (const { img } of pending) {
        img.title = LOAD_FAIL_TITLE;
      }
    });
}
