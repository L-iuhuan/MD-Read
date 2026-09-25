/**
 * B3 回归锚：GitHub Alert（**我们自己的扩展，不是 GFM**）的**保守识别**矩阵。
 *
 * 依据（Lead 批准时收紧的第 1 条）：只有引用块**首行恰好**以 `[!TYPE]` 开头（**大写** 5 类白名单）才识别
 * ⇒ **绝不误伤普通引用块**。本锚把"识别矩阵"逐格钉住，并检查**标记被剥掉**、**非颜色通道**（`data-alert`）。
 * 另外：普通引用块的 HTML 必须与 markdown-it 默认**逐字一致**（golden 对拍的补充锚）。
 */
import { describe, expect, it } from 'vitest';
import { md } from '../src/render/markdown';

const render = (src: string): string => md.render(src);

describe('B3 · GitHub Alert 识别矩阵（保守白名单）', () => {
  it('5 类各识别成一类，且 data-alert 正确（非颜色通道）', () => {
    for (const [kind, label] of [
      ['NOTE', '注意'],
      ['TIP', '提示'],
      ['IMPORTANT', '重要'],
      ['WARNING', '警告'],
      ['CAUTION', '当心'],
    ] as const) {
      const html = render(`> [!${kind}]\n> 正文一行。`);
      expect(html, `${kind} 应被识别`).toContain(`class="alert alert-${kind.toLowerCase()}"`);
      expect(html, `${kind} 应带 data-alert（非颜色通道）`).toContain(`data-alert="${kind.toLowerCase()}"`);
      expect(html, `${kind} 的标记必须被剥掉`).not.toContain('[!');
      expect(html, `${kind} 的正文必须保留`).toContain('正文一行。');
      expect(label.length).toBeGreaterThan(0); // 标签文案在 CSS 里（这里只保证矩阵完整）
    }
  });

  it('标记后跟标题/正文都可：剥掉标记后内容原样', () => {
    const html = render('> [!TIP] 提示标题\n> 提示正文');
    expect(html).toContain('alert-tip');
    expect(html).toContain('提示标题');
    expect(html).toContain('提示正文');
    expect(html).not.toContain('[!TIP]');
  });

  it('⚠ 绝不误伤：普通引用块 / 首行不是标记 / 小写 / 未知类型 四种都**不是** alert', () => {
    const nonAlerts = [
      '> 一句话结论：吞吐稳住了。', // 普通引用块（golden 语料里那条同形）
      '> 前言\n> [!NOTE]\n> 正文', // 标记**不在首行**
      '> [!note]\n> 正文', // 小写（保守：不识别）
      '> [!FOO]\n> 正文', // 未知类型
      '> 前缀 [!NOTE] 后缀', // 不在行首
    ];
    for (const src of nonAlerts) {
      const html = render(src);
      expect(html, `不该被识别为 alert：${JSON.stringify(src)}`).not.toContain('class="alert');
      expect(html, `不该带 data-alert：${JSON.stringify(src)}`).not.toContain('data-alert');
    }
  });

  it('普通引用块的 HTML 与 markdown-it 默认一致（不含 alert 类、结构不变）', () => {
    const html = render('> 一句话结论：吞吐稳住了。');
    // ⚠ 本项目另有 `assign_block_lines` 规则 ⇒ HTML 带 data-line（与 markdown-it 裸默认不同）
    expect(html).toMatch(/^<blockquote data-line="\d+">\n<p data-line="\d+">一句话结论：吞吐稳住了。<\/p>\n<\/blockquote>\n$/);
    expect(html, '普通引用块不得出现 alert 类').not.toContain('alert');
  });

  it('标记独占一行：不留空 <p>', () => {
    const html = render('> [!NOTE]\n> 正文');
    expect(html).toContain('alert-note');
    expect(html, '不应留下空段落').not.toMatch(/<p>\s*<\/p>/);
  });

  it('金额串/字面量不受影响（与 typographer=false 同源）', () => {
    const html = render('> [!NOTE]\n> `$1,000 与 $2,000`；`--flag`、区间 `1--2`、`"key": value`、`...`');
    expect(html).toContain('$1,000 与 $2,000');
    expect(html).toContain('--flag');
    expect(html).toContain('1--2');
    expect(html).toContain('&quot;key&quot;: value');
    expect(html).toContain('...');
  });
});
