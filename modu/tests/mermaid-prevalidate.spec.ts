/**
 * A5 回归锚：Mermaid **提前校验**（parse-only）+ 失败文案可读 + 不破坏源码兜底。
 *
 * 改前实测（对照基线）：
 *  · 坏图**在折叠线以下** ⇒ `[data-mmd-error]` = **0**（完全静默 ✗）
 *  · 报错文案 = **`[object Object]`**（mermaid 抛对象型错误，`String(err)` 无用 ✗）
 *
 * 本锚用**注入解析器**（`deps.parse`）⇒ 不必在 jsdom 里真跑 mermaid（它需要布局引擎）。
 */
import { describe, expect, it } from 'vitest';
import { prevalidateMermaid } from '../src/render/mermaid';

const SRC_BAD = 'graph TD\n  A[开始] --> B{判断\n';
const SRC_GOOD = 'graph TD\n  A --> B\n';

function container(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const rejectWith = (err: unknown) => (): Promise<unknown> => Promise.reject(err);
const resolveOk = (): Promise<unknown> => Promise.resolve(true);

describe('A5 · Mermaid 提前校验', () => {
  it('坏图：提前标出 + 文案来自错误对象（**不是 `[object Object]`**）+ 源码仍保留', async () => {
    const c = container(`<div class="mermaid">${SRC_BAD}</div>`);
    const el = c.querySelector<HTMLElement>('.mermaid') as HTMLElement;

    const res = await prevalidateMermaid(c, { parse: rejectWith({ message: '语法错：第 2 行缺少 }' }) });

    expect(res).toEqual({ checked: 1, invalid: 1 });
    expect(el.hasAttribute('data-mmd-invalid'), '坏图应落 data-mmd-invalid').toBe(true);
    const msg = el.getAttribute('data-mmd-error') ?? '';
    expect(msg, '文案应写进属性').toContain('语法错：第 2 行缺少 }');
    // ⚠ 与 `boot-error.spec.ts` 那条 `toContain("[object Object]")` **不矛盾**：那条锚的是
    //   **循环引用**下 JSON 化抛错后的最后兜底；这里针对 mermaid 的**普通对象**型错误（可读）✓
    expect(msg, '⚠ 绝不能再出现 [object Object]（改前实测就是这个）').not.toContain('[object Object]');
    expect(el.textContent, '源码文本必须保留（阅读/导出兜底）').toContain('graph TD');
    expect(el.dataset.src, '源码应记进 data-src（懒渲染/重画共用）').toBe(SRC_BAD);
  });

  it('好图：只落 `data-mmd-valid`，**不落** error/invalid（行为与改前一致：交给懒渲染）', async () => {
    const c = container(`<div class="mermaid">${SRC_GOOD}</div>`);
    const el = c.querySelector<HTMLElement>('.mermaid') as HTMLElement;

    const res = await prevalidateMermaid(c, { parse: resolveOk });

    expect(res).toEqual({ checked: 1, invalid: 0 });
    expect(el.hasAttribute('data-mmd-valid')).toBe(true);
    expect(el.hasAttribute('data-mmd-error'), '好图不得被标成错误').toBe(false);
    expect(el.hasAttribute('data-mmd-invalid')).toBe(false);
    expect(el.hasAttribute('data-rendered'), '校验不等于渲染 ⇒ 不得置 data-rendered').toBe(false);
  });

  it('已定稿节点被跳过（与懒渲染/主题重画不打架）：rendered 与 error 两种都跳', async () => {
    const c = container(
      `<div class="mermaid" data-rendered="1">${SRC_GOOD}</div>` +
        `<div class="mermaid" data-mmd-error="图表语法错误：早先已报">${SRC_BAD}</div>`,
    );
    let called = 0;
    const res = await prevalidateMermaid(c, {
      parse: () => {
        called += 1;
        return Promise.resolve(true);
      },
    });
    expect(res).toEqual({ checked: 0, invalid: 0 });
    expect(called, '已定稿的节点不应再被 parse').toBe(0);
  });

});

describe('A5 · Mermaid 提前校验（边界与批量）', () => {
  it('没有 .mermaid 时零成本（checked=0，且不会去加载 mermaid）', async () => {
    const c = container('<p>普通段落</p>');
    const res = await prevalidateMermaid(c);
    expect(res).toEqual({ checked: 0, invalid: 0 });
  });

  it('多个坏图：逐个标记、数目正确（不会因一个失败就中断后面的）', async () => {
    const c = container(
      `<div class="mermaid">${SRC_GOOD}</div><div class="mermaid">${SRC_BAD}</div><div class="mermaid">${SRC_BAD}</div>`,
    );
    const res = await prevalidateMermaid(c, { parse: rejectWith(new Error('语法错')) });
    expect(res).toEqual({ checked: 3, invalid: 3 });
    expect(c.querySelectorAll('.mermaid[data-mmd-invalid]').length).toBe(3);
    expect(c.querySelectorAll('.mermaid[data-mmd-error]').length).toBe(3);
  });
});
