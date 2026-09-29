/**
 * 外链劫持拦截（P5 批1·P0 #1）。CDP 实锤：WebView2 里点 http(s) 外链，整窗被导航走。
 * 本模块在正文容器上以捕获阶段委托拦截：外链 → preventDefault + opener 插件交系统浏览器；
 * 内锚（#xxx）保持 WebView 默认行为。
 * C3（2026-09-29）：相对链接同样 preventDefault——放行默认导航会把整窗带到 404。
 *   href 以 md/markdown/mdx 结尾（大小写不敏感）→ 按当前文档目录解析为绝对路径，
 *   交注入的 openMd（main.ts 接既有 openPath 链：归一/受信校验/开标签全复用，
 *   不新写信任登记路径）；其余 → notify 状态栏闪示。空 href 与 # 内锚保持现状不动。
 * 接线（批2）：mountRendered 末尾调 setupExternalLinks(doc, handlers)。
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { isMarkdownPath } from "./md-ext";

/** 链接分类：外链走系统浏览器；mailto/tel 走系统默认应用（F4）；内锚与相对链接
 *  保持 WebView 默认行为；其余未知协议（ftp: 等）提示不支持 */
export type HrefKind = "external" | "anchor" | "relative" | "mailto" | "tel" | "unsupported";

/**
 * 纯函数：href 分类判定。
 * http:// 或 https:// 开头（大小写不敏感）→ 外链；# 开头 → 内锚；
 * mailto:/tel:（大小写不敏感）→ 交 opener（capabilities 的 opener:allow-default-urls
 * 许可清单恰为 http/https/mailto/tel）；其余带 scheme 的 → 不支持（单字母「盘符:」
 * 形态不算 scheme，仍按相对路径处理）；无 scheme → 相对。
 */
export function classifyHref(href: string): HrefKind {
  if (/^https?:\/\//i.test(href)) {
    return "external";
  }
  if (href.startsWith("#")) {
    return "anchor";
  }
  if (/^mailto:/i.test(href)) {
    return "mailto"; // F4（P2-8）：此前落 relative → nav-guard 取消 → 点击无反应
  }
  if (/^tel:/i.test(href)) {
    return "tel";
  }
  if (/^[a-z][a-z0-9+.-]+:/i.test(href)) {
    return "unsupported"; // ftp: 等其余协议
  }
  return "relative";
}

/** 相对链接处理通道（main.ts 注入；缺省时相对链接只拦不开） */
export interface RelativeLinkHandlers {
  /** 当前文档绝对路径（相对链接的解析基准目录） */
  docPath?: () => string | null;
  /** 相对 md 链接 → 绝对路径（走既有 openPath 打开链） */
  openMd?: (absolutePath: string) => void;
  /** 非 md 相对链接的用户可见提示通道（状态栏闪示） */
  notify?: (message: string) => void;
}

/**
 * 纯函数：相对 href → 基于当前文档目录的绝对 Windows 路径。
 * 只做词法拼接与 `.`/`..` 归并（`..` 夹到盘符根，不越界穿出）；canonical 形态
 * （`\\?\c:\...` 的 UNC 前缀）原样保留——最终归一由 openPath 里的 Rust
 * normalize_path 收口（全仓唯一一份实现）。
 */
export function resolveRelativeHref(href: string, docPath: string): string {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href); // markdown-it 会把空格等百分号编码
  } catch (error) {
    if (!(error instanceof URIError)) {
      throw error;
    }
    // 裸 % 等非法序列：按原样拼接
  }
  const prefix = docPath.startsWith("\\\\") ? "\\\\" : "";
  const segments = docPath.split(/[\\/]/).filter((seg) => seg !== "");
  segments.pop(); // 去掉文件名，留目录
  for (const seg of decoded.split(/[\\/]/)) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (segments.length > 1) {
        segments.pop(); // 盘符/根之上不再上溯
      }
      continue;
    }
    segments.push(seg);
  }
  return prefix + segments.join("\\");
}

/** 每次接线刷新 handlers（容器监听只注册一次，基准路径随文档换新） */
const handlersByContainer = new WeakMap<HTMLElement, RelativeLinkHandlers>();

/**
 * 容器级拦截（幂等：data 标记防重复注册；容器 innerHTML 重写不影响，
 * 因为标记挂在容器自身，重复调用直接返回——handlers 每次调用都会刷新）。
 */
export function setupExternalLinks(
  container: HTMLElement,
  handlers: RelativeLinkHandlers = {},
): void {
  handlersByContainer.set(container, handlers);
  if (container.dataset.extLinks === "1") {
    return;
  }
  container.dataset.extLinks = "1";
  container.addEventListener(
    "click",
    (event) => {
      const current = handlersByContainer.get(container) ?? {};
      const anchor = nearestAnchor(event.target);
      const href = anchor?.getAttribute("href") ?? null;
      if (href === null || href === "") {
        return; // 无 href / 空 href：保持默认行为（C3 语义：现状不动）
      }
      const kind = classifyHref(href);
      if (kind === "anchor") {
        return; // 内锚：WebView 内滚动
      }
      if (kind === "external" || kind === "mailto" || kind === "tel") {
        // 外链与 mailto:/tel:（F4）：交系统默认应用。放行默认导航会把整窗带走，必须拦。
        event.preventDefault();
        openUrl(href).catch((error: unknown) => {
          // 打开失败不吞不炸：本模块没有状态栏通道，留控制台证据即可
          console.error(`无法在系统浏览器打开链接：${String(error)}`);
        });
        return;
      }
      if (kind === "unsupported") {
        // 未知协议（ftp: 等，F4）：拦下不导航，状态栏说明
        event.preventDefault();
        current.notify?.(`暂不支持 ${href.slice(0, href.indexOf(":"))}: 链接`);
        return;
      }
      // 相对链接（C3）：默认导航会把整窗带走（404），一律拦截
      event.preventDefault();
      if (isMarkdownPath(href)) {
        const docPath = current.docPath?.() ?? null;
        if (docPath !== null && current.openMd !== undefined) {
          current.openMd(resolveRelativeHref(href, docPath));
        }
        return; // 无基准/无通道（未注入的老调用方）：拦而不开
      }
      current.notify?.("该链接指向应用外文件，未打开");
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
