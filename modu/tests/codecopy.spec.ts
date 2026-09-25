/**
 * 代码块复制按钮（用户反馈批次·本期新功能）：
 * - attachCodeCopyButtons：只挂 pre[data-lang] 且有 code 子节点者；幂等（重挂不双挂）；
 * - makeCopyHandler：成功闪「已复制」ok / 失败闪中文错误 error（writeText 注入替身）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachCodeCopyButtons, makeCopyHandler } from "../src/render/codecopy";

beforeEach(() => {
  document.body.innerHTML = `
    <span id="st-saved" hidden></span>
    <article id="doc">
      <pre data-lang="ts"><code class="language-ts hljs">const a = 1;</code></pre>
      <pre data-lang="mermaid"><code class="language-mermaid">flowchart TD</code></pre>
      <pre><code>无语言标记</code></pre>
      <pre data-lang="txt"></pre>
    </article>`;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function statusEl(): HTMLElement {
  return document.getElementById("st-saved") as HTMLElement;
}

describe("按钮挂载", () => {
  it("给 pre[data-lang]（含 code）挂钮：class/title/aria/SVG 就位；无 code 者跳过", () => {
    attachCodeCopyButtons(document.getElementById("doc") as HTMLElement);
    const btns = document.querySelectorAll("#doc .code-wrap .code-copy");
    expect(btns.length).toBe(2); // txt 块无 code 子节点、无 data-lang 块不挂
    const btn = btns[0] as HTMLElement;
    expect(btn.title).toBe("复制代码");
    expect(btn.getAttribute("aria-label")).toBe("复制代码");
    expect(btn.querySelector("svg")).not.toBeNull();
  });

  it("幂等：重复调用不双挂（缓存重挂路径）", () => {
    const doc = document.getElementById("doc") as HTMLElement;
    attachCodeCopyButtons(doc);
    attachCodeCopyButtons(doc);
    expect(document.querySelectorAll("#doc .code-wrap .code-copy").length).toBe(2);
  });
});

describe("点击回调（mock clipboard）", () => {
  it("成功：writeText 收到代码文本，闪「已复制」ok", async () => {
    attachCodeCopyButtons(document.getElementById("doc") as HTMLElement);
    const writeText = vi.fn((): Promise<void> => Promise.resolve());
    // 直接验证 makeCopyHandler（挂载处用的就是它，getText 同源取 code.textContent）
    makeCopyHandler(
      () => (document.querySelector("#doc pre code") as HTMLElement).textContent ?? "",
      writeText,
    )();
    await vi.waitFor(() => {
      expect(statusEl().textContent).toBe("已复制");
    });
    expect(statusEl().className).toBe("st-ok");
    expect(writeText).toHaveBeenCalledWith("const a = 1;");
  });

  it("失败：闪中文错误 error，不抛出", async () => {
    makeCopyHandler(() => "x", () => Promise.reject(new Error("剪贴板被占用")))();
    await vi.waitFor(() => {
      expect(statusEl().textContent).toBe("复制失败：剪贴板被占用");
    });
    expect(statusEl().className).toBe("st-error");
  });

  it("挂载的钮点击走真回调路径：点击后闪「已复制」", async () => {
    const writeText = vi.fn((): Promise<void> => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    // 重新挂载以绑定 stub 后的 defaultWriteText
    document.body.innerHTML =
      '<span id="st-saved" hidden></span><pre data-lang="ts"><code>let z = 9;</code></pre>';
    attachCodeCopyButtons(document.body);
    (document.querySelector(".code-copy") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(statusEl().textContent).toBe("已复制");
    });
    expect(writeText).toHaveBeenCalledWith("let z = 9;");
  });
});
