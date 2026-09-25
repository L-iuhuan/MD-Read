/**
 * A6 静态锚：钉住 `tabs.ts` 里那条**防御性**票号守卫、它的**诚实标签**，以及它依赖的**同步前提**。
 *
 * 为什么要有这条锚（Lead 收紧：钉**三件**事）：
 * 1. **守卫存在**：`loadEditorState` 等状态改动都在 `ticket === renderTicket` 之内 ⇒ 过期票不得挂载；
 * 2. **诚实标签**：这是**未复现**前提下的**防御性加固**、**非已验证修复**。一旦有人把它当"已验证的修复"，
 *    就会**高估这条链路的可信度** ✗ ⇒ 反向断言标签必须在；
 * 3. **同步前提**：今天安全的原因之一是"**缓存命中路径全同步**"（无 await 边界 ⇒ 无交错窗口）。
 *    将来有人把它改成异步，**必须立刻看得见** —— 否则这个守卫会从"防御"变成"唯一防线"而没人知道 ✗
 *    ⇒ 对那条注释也加锚。
 *
 * 只做静态断言（读源码文本），不启动应用。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE = path.join('src', 'app', 'tabs.ts');
const text = readFileSync(SOURCE, 'utf8');

/** 取一段源码：从 `from` 起到 `to`（不含） */
function slice(from: string, to: string): string {
  const at = text.indexOf(from);
  if (at === -1) throw new Error(`tabs.ts 里找不到：${from}`);
  const end = text.indexOf(to, at + from.length);
  return text.slice(at, end === -1 ? undefined : end);
}

const finishMount = slice('function finishMount(', '\n  function activateTab(');
const cacheHitBranch = slice('if (cached !== null) {', 'deps.beginLoading');

describe('A6 票号守卫静态锚（防御性加固 + 诚实标签 + 同步前提）', () => {
  it('① 守卫存在：票号比对在**消费缓存/挂载/接线编辑器态之前**，且 `loadEditorState` 在其内', () => {
    const guardAt = finishMount.indexOf('if (ticket !== renderTicket)');
    expect(guardAt, 'finishMount 里应有 `if (ticket !== renderTicket)` 守卫（防过期票挂载）').toBeGreaterThan(-1);
    for (const [name, needle] of [
      ['消费缓存 `target.cachedFragment = null`', 'target.cachedFragment = null'],
      ['挂载 `deps.mountDoc(ctx)`', 'deps.mountDoc(ctx)'],
      ['接线编辑器态 `deps.loadEditorState?.(target.editor)`', 'deps.loadEditorState?.(target.editor)'],
    ] as const) {
      const at = finishMount.indexOf(needle);
      expect(at, `finishMount 里应能找到：${name}`).toBeGreaterThan(-1);
      expect(guardAt, `守卫必须在「${name}」之前（否则过期票已经改了状态）`).toBeLessThan(at);
    }
  });

  it('② 缓存命中分支仍同步直挂 finishMount（守卫因此覆盖它）', () => {
    expect(cacheHitBranch, '缓存命中分支必须调用 finishMount（守卫才会作用到它）').toContain('finishMount(');
    // ⚠ 先剥掉注释行再判定 `await` —— 否则会**自匹配**注释里那句"不许出现 await"（检查脚本自匹配假阳性）
    const code = cacheHitBranch
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(
      /await/.test(code),
      '⚠ 缓存命中分支出现了 `await`：这条前提一旦被破坏，finishMount 的守卫就从"防御"变成"唯一防线"，' +
        '必须显式复核 A6 报告与票号语义（同步前提注释在 tabs.ts 该分支上）',
    ).toBe(false);
  });

  it('③ 诚实标签：注释里必须有「未复现」「防御性加固」「非已验证修复」（防被当已验证修复 → 高估可信度）', () => {
    const head = finishMount.slice(0, finishMount.indexOf('if (ticket !== renderTicket)'));
    expect(head, '守卫前注释必须写明「未复现」（该守卫是未复现前提下的加固）').toContain('未复现');
    expect(head, '守卫前注释必须写明「防御性加固」（不许写成"修复了 bug"）').toContain('防御性加固');
    expect(head, '守卫前注释必须写明「非已验证修复」（防后人高估这条链路的可信度）').toContain('非已验证修复');
  });

  it('④ 同步前提有锚：缓存命中分支的注释必须写明"必须保持全同步"，并指向本锚', () => {
    expect(cacheHitBranch, '缓存命中分支注释必须写明「这条路径必须保持全同步」').toContain('必须保持全同步');
    expect(cacheHitBranch, '缓存命中分支注释必须指向本锚（改了会红）').toContain('a6-ticket-guard.spec.ts');
  });
});
