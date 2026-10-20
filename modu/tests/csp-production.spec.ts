/**
 * 生产 CSP × 运行时注入样式契约（静态锚，2026-10-20 装机版编辑态全乱真根因）。
 *
 * 背景（真机取证，详见 modu/AGENTS.md「生产 CSP」节）：
 *  - CM6（style-mod）与 `#content` 加载条都在**运行时**创建 `<style>` 元素；
 *  - Tauri v2 打包时默认改写 CSP：给 script-src / style-src 注入 nonce 与内联资源 hash；
 *    按 CSP3，指令里一旦出现 nonce/hash，`'unsafe-inline'` 即被忽略
 *    ⇒ 运行时 <style> 无 nonce/hash ⇒ 被 style-src-elem 拦截（DOM 里有 style 标签但 sheet=null）
 *    ⇒ CM6 的 baseTheme/自定义主题全部不生效 ⇒ 编辑态「行号在上、内容在下、无行号列」；
 *  - 只在**生产构建**注入（dev 走 Vite，无此 CSP）⇒ 只跑 `pnpm tauri dev` 的真机验收会漏掉。
 *
 * 修复：`app.security.dangerousDisableAssetCspModification = ["style-src"]`，
 * 并保留 `style-src 'self' 'unsafe-inline'`；script-src 仍交给 Tauri 收紧（不得整体关闭修改）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface TauriConf {
  app?: { security?: { csp?: string; dangerousDisableAssetCspModification?: boolean | string[] } };
}
const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as TauriConf;
const security = conf.app?.security ?? {};
const disabled = security.dangerousDisableAssetCspModification;

describe("生产 CSP：运行时注入 <style> 必须可用（编辑态 CM6 依赖）", () => {
  it("style-src 保留 'unsafe-inline'", () => {
    expect(security.csp ?? "").toContain("style-src 'self' 'unsafe-inline'");
  });

  it("Tauri 资源 CSP 修改对 style-src 关闭（否则 nonce/hash 让 unsafe-inline 失效 ⇒ 编辑态样式全丢）", () => {
    const off = disabled === true || (Array.isArray(disabled) && disabled.includes("style-src"));
    expect(off).toBe(true);
  });

  it("script-src 仍交给 Tauri 收紧：不得整体关闭 CSP 修改，也不得放开 script-src", () => {
    expect(disabled).not.toBe(true);
    if (Array.isArray(disabled)) {
      expect(disabled).not.toContain("script-src");
    }
  });
});
