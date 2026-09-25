/**
 * 「常规文档」语料生成器（2026-09-23，常规文档打开性能专项）。
 *
 * 形态＝最该被服务好的那一种：标题 + 段落 + 列表 + 少量代码块 + 少量表格（+ 少量公式变体）。
 * 规模用**应用自己的打印版式**标定：先按份数生成 → 应用导出 PDF → `pdfinfo` 读 Pages → 按比例调份数。
 * 份数写死在 RUNG 里（标定后回填），保证复跑得到同一批文件。
 *
 * 用法：node tests/corpus/生成常规文档语料.mjs [输出目录]
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? path.join(HERE, '..', '..', '..', '.verify', 'phase2', 'regular-corpus');
mkdirSync(OUT, { recursive: true });

/** 标定后的份数（2026-09-23 实测：1 节 ≈ 0.74 页 A4；用「导出 PDF + pdfinfo」回填） */
const RUNG = [
  { name: '常规-10页', sections: 14 },
  { name: '常规-30页', sections: 41 },
  { name: '常规-100页', sections: 136 },
  { name: '常规-200页', sections: 272 },
  { name: '常规-30页-含公式', sections: 38, math: true },
];

function paragraph(i, j) {
  return (
    `第 ${i}-${j} 段：本季度我们把数据接入从人工导出换成脚本拉取，覆盖 12 个业务域、约 340 张表，`
    + '日均拉取耗时从 42 分钟降到 28 分钟，行数偏差告警从 17 次降到 3 次。'
    + `口径统一后，“金额”一律为 decimal(18,4)，重跑不再产生重复行；本文用于常规文档打开性能的标定，编号 ${i}-${j}。`
  );
}

function section(i, math) {
  const parts = [`## 第 ${i} 节\n\n`];
  for (let j = 1; j <= 3; j += 1) parts.push(`${paragraph(i, j)}\n\n`);
  parts.push(`- 要点一：脚本幂等（编号 ${i}）\n- 要点二：监控两个指标（耗时、行数偏差）\n- 要点三：口径以财务为准\n\n`);
  if (math && i % 1 === 0) parts.push(`换算口径：\\( \\alpha_{${i}} + \\beta_{${i}} = \\gamma_{${i}} \\)，其中系数由财务给定。\n\n`);
  parts.push(`> 备注：第 ${i} 节的结论只在本季度有效。\n\n`);
  if (i % 5 === 0) {
    parts.push(
      `\`\`\`python\ndef fetch_${i}(domain, day):\n    rows = client.query(domain, day)\n    if not idempotent_ok(rows):\n        raise RuntimeError("行数偏差超阈")\n    return normalize(rows)\n\`\`\`\n\n`,
    );
  }
  if (i % 7 === 0) {
    parts.push(
      `| 指标 | 上季 | 本季 | 变化 |\n|---|---|---|---|\n| 日均耗时 | 42 min | 28 min | −33% |\n| 偏差告警 | 17 次 | 3 次 | −82% |\n| 人工介入 | 21 次 | 6 次 | −71% |\n| 失败重跑 | 9 次 | 1 次 | −89% |\n\n`,
    );
  }
  return parts.join('');
}

for (const rung of RUNG) {
  const parts = [`# ${rung.name}（常规文档性能标定语料）\n\n本文形态：标题 + 段落 + 列表 + 少量代码块 + 少量表格${rung.math ? ' + 每节一个行内公式' : ''}。\n\n`];
  for (let i = 1; i <= rung.sections; i += 1) parts.push(section(i, rung.math === true));
  const file = path.join(OUT, `${rung.name}.md`);
  writeFileSync(file, parts.join(''), 'utf8');
  console.log(`${(statSync(file).size / 1024).toFixed(0).padStart(6)} KB  ${rung.name}.md  (sections=${rung.sections}${rung.math ? ', math' : ''})`);
}
console.log(`\n已生成到 ${OUT}（页数需用「导出 PDF + pdfinfo」标定后回填 RUNG）`);
