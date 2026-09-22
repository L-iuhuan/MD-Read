/**
 * 外链劫持拦截（P5 批1·P0 #1）。CDP 实锤：WebView2 里点 http(s) 外链，整窗被导航走。
 * 本模块在正文容器上以捕获阶段委托拦截：外链 → preventDefault + opener 插件交系统浏览器；
 * 内锚（#xxx）与相对链接放行默认行为。接线（批2）：mountRendered 末尾调 setupExternalLinks(doc)。
 */
import { openUrl } from "@tauri-apps/plugin-opener";

/** 链接分类：外链走系统浏览器；内锚与相对链接保持 WebView 默认行为 */
export type HrefKind = "external" | "anchor" | "relative";

/**
 * 纯函数：href 分类判定。
 * http:// 或 https:// 开头（大小写不敏感）→ 外链；# 开头 → 内锚；其余 → 相对。
 */
export function classifyHref(href: string): HrefKind {
  if (/^https?:\/\//i.test(href)) {
    return "external";
  }
  if (href.startsWith("#")) {
    return "anchor";
  }
  return "relative";
}

/**
 * 容器级外链拦截（幂等：data 标记防重复注册；容器 innerHTML 重写不影响，
 * 因为标记挂在容器自身，重复调用直接返回）。
 */
export function setupExternalLinks(container: HTMLElement): void {
  if (container.dataset.extLinks === "1") {
    return;
  }
  container.dataset.extLinks = "1";
  container.addEventListener(
    "click",
    (event) => {
      const anchor = nearestAnchor(event.target);
      const href = anchor?.getAttribute("href") ?? null;
      if (href === null || classifyHref(href) !== "external") {
        return;
      }
      event.preventDefault();
      openUrl(href).catch((error: unknown) => {
        // 打开失败不吞不炸：本模块没有状态栏通道，留控制台证据即可
        console.error(`无法在系统浏览器打开链接：${String(error)}`);
      });
    },
    true // 捕获阶段：抢在任何冒泡层处理器之前定夺
  );
}

/** 事件目标到最近 <a href> 祖先（点击落在链接内嵌元素时向上找） */
function nearestAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const anchor = target.closest("a[href]");
  return anchor instanceof HTMLAnchorElement ? anchor : null;
}
