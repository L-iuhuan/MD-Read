/**
 * 代码块复制按钮（用户反馈批次·本期新功能）：渲染后处理给 pre[data-lang]
 * 挂右上角 hover 浮现的复制钮（样式在 cjk.css §3，打印隐藏在 print.css）。
 *
 * - 按钮由本模块自建（在 DOMPurify 之后挂载，不经过 markdown 管线）；
 * - 点击 navigator.clipboard.writeText(代码文本) + flashStatus("已复制","ok")；
 *   失败闪 error 不弹窗（WebView2 对应用页面默认给 clipboard 权限，CSP 不管辖
 *   Clipboard API）；
 * - 幂等：已有 .code-copy 的 pre 跳过（缓存重挂路径重复调用不双挂）；
 * - makeCopyHandler 独立导出（getText/writeText 皆可注入），测试免真剪贴板。
 */
import { flashStatus } from "../editor/editor";

export type WriteText = (text: string) => Promise<void>;

/** 点击回调（纯接线）：成功闪「已复制」，失败闪中文错误（不弹窗） */
export function makeCopyHandler(getText: () => string, writeText: WriteText): () => void {
  return () => {
    void writeText(getText()).then(
      () => flashStatus("已复制", "ok"),
      (error: unknown) => {
        flashStatus(
          `复制失败：${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      },
    );
  };
}

function defaultWriteText(text: string): Promise<void> {
  if (navigator.clipboard === undefined) {
    return Promise.reject(new Error("剪贴板不可用"));
  }
  return navigator.clipboard.writeText(text);
}

/** 14×14 双框复制图标（10px 线条、currentColor，与壳层 SVG 同一视觉语言） */
function copyIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  for (const [key, value] of [
    ["width", "14"],
    ["height", "14"],
    ["viewBox", "0 0 16 16"],
    ["aria-hidden", "true"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "1.2"],
    ["stroke-linejoin", "round"],
  ] as const) {
    svg.setAttribute(key, value);
  }
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "5.5");
  rect.setAttribute("y", "5.5");
  rect.setAttribute("width", "8");
  rect.setAttribute("height", "8");
  rect.setAttribute("rx", "1.2");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M10.5 2.5h-8v8");
  svg.append(rect, path);
  return svg;
}

/** 给 container 内每个 pre[data-lang]（且有 code 子节点）挂复制钮。
 *
 *  P2Q-34：按钮必须挂在**不随内容滚动的外层** `div.code-wrap`（`position: relative`）。
 *  此前直接 `pre.appendChild(btn)`，而 `pre` 是横向滚动容器（`overflow-x: auto`）——
 *  绝对定位子元素的包含块是它的**内容盒**，于是横向滚动时按钮跟着内容跑：
 *  实测 `pre.scrollLeft` 0 → 256 时按钮 `left` 1276 → 1020（位移 −256px，跑到视口外）。
 */
export function attachCodeCopyButtons(container: ParentNode): void {
  for (const pre of Array.from(
    container.querySelectorAll<HTMLPreElement>("pre[data-lang]"),
  )) {
    const wrapper = pre.parentElement;
    if (wrapper !== null && wrapper.classList.contains("code-wrap")) {
      continue; // 幂等（缓存重挂路径不双挂）
    }
    const code = pre.querySelector("code");
    if (code === null) {
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.title = "复制代码";
    btn.setAttribute("aria-label", "复制代码");
    btn.appendChild(copyIcon());
    btn.addEventListener(
      "click",
      makeCopyHandler(() => code.textContent ?? "", defaultWriteText),
    );
    const wrap = document.createElement("div");
    wrap.className = "code-wrap";
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    wrap.appendChild(btn);
  }
}
