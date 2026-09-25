/**
 * P1 语料生成器（2026-09-23）：为「按文档类型分层开启 content-visibility」造测量语料。
 *
 * 为什么是脚本而不是直接入库大文件：这些语料合计 25MB+，进仓库会把体积顶起来（MSI 门禁 8MB
 * 是产物门禁，但仓库也没必要背这堆字节）。生成器入库、语料生成到 gitignore 的 `.verify/` 下，
 * 任何人在本机 `node tests/corpus/生成P1语料.mjs` 就能复现同一批文件（内容确定性生成，无随机）。
 *
 * 产出（默认写到 <仓库根>/.verify/phase2/p1-corpus/）：
 *  阶梯-05K / 20K / 50K / 100K / 200K.md   纯散文按比例放大（节点数阶梯，隔离"规模"这一个变量）
 *  代码密集.md     200 个 fenced code（js/ts/python/rust/json，含高亮）
 *  表格密集.md     60 张 6×5 表格
 *  Mermaid密集.md  20 个 mermaid 流程图（懒渲染）+ 散文
 *  长段落.md       极长段落（无代码 / 无公式 / 无表格 / 无列表）
 *  典型用户文档.md 真实笔记/报告形态：标题 + 段落 + 列表 + 4 段代码 + 1 张表 + 1 个公式
 *
 * 用法：node tests/corpus/生成P1语料.mjs [输出目录]
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ?? path.join(HERE, '..', '..', '..', '.verify', 'phase2', 'p1-corpus');
mkdirSync(OUT, { recursive: true });

/** 一段"典型散文"（含少量行内强调/行内代码/链接，让行内元素也进节点数） */
function proseBlock(i) {
  return [
    `本段为第 ${i} 段性能对照内容：中文与 English 混排，金额 1,000 与 2,345.67，`,
    `长标识符 \`performance_plain_row_mark\`，普通文本若干用于填充体积，`,
    `**加粗**与*斜体*各一处，[外链](https://example.com/${i}) 一处，不含任何数学定界符。`,
  ].join('');
}

function write(name, text) {
  const file = path.join(OUT, name);
  writeFileSync(file, text, 'utf8');
  console.log(`${(statSync(file).size / 1048576).toFixed(2).padStart(6)} MB  ${name}`);
}

/* ---------- 1. 阶梯：同一种内容按比例放大 ---------- */
for (const [label, targetMb] of [['05K', 0.36], ['20K', 1.4], ['50K', 3.6], ['100K', 7.1], ['200K', 14.2]]) {
  const parts = [];
  let bytes = 0;
  const limit = targetMb * 1048576;
  let i = 0;
  while (bytes < limit) {
    i += 1;
    const chunk = `${i % 20 === 0 ? `\n## 第 ${i} 节\n\n` : ''}${proseBlock(i)}\n\n`;
    parts.push(chunk);
    bytes += Buffer.byteLength(chunk, 'utf8');
  }
  write(`阶梯-${label}.md`, `# 阶梯语料 ${label}（纯散文，按比例放大）\n\n${parts.join('')}`);
}

/* ---------- 2. 代码密集：目标 ~1.2MB 的 fenced code（五种语言，真实配比） ---------- */
{
  const langs = ['js', 'ts', 'python', 'rust', 'json'];
  const parts = ['# 代码密集语料（~1.2MB，五种语言，约 400 个代码块）\n\n'];
  let bytes = Buffer.byteLength(parts[0], 'utf8');
  const limit = 1.2 * 1048576;
  for (let i = 0; bytes < limit; i += 1) {
    const lang = langs[i % langs.length];
    const body =
      lang === 'json'
        ? `{\n  "id": ${i},\n  "name": "row_${i}",\n  "amount": ${1000 + i}.5,\n  "tags": ["a", "b", "c"]\n}`
        : lang === 'python'
          ? `def row_${i}(values, factor=${i + 1}):\n    """第 ${i} 个处理函数。"""\n    total = 0\n    for v in values:\n        total += v * factor\n    return total\n`
          : lang === 'rust'
            ? `fn row_${i}(values: &[i64]) -> i64 {\n    // 第 ${i} 个函数\n    values.iter().map(|v| v * ${i + 1}).sum()\n}\n`
            : `function row${i}(values) {\n  let total = 0;\n  for (const v of values) total += v * ${i + 1};\n  return total;\n}\n`;
    const chunk = `## 第 ${i + 1} 段代码\n\n说明：第 ${i + 1} 个代码块，语言 ${lang}。\n\n\`\`\`${lang}\n${body}\`\`\`\n\n${proseBlock(i)}\n\n`;
    parts.push(chunk);
    bytes += Buffer.byteLength(chunk, 'utf8');
  }
  write('代码密集.md', parts.join(''));
}

/* ---------- 3. 表格密集：目标 ~0.5MB 的 6×5 表格 ---------- */
{
  const parts = ['# 表格密集语料（~0.5MB，6×5 表格）\n\n'];
  let bytes = Buffer.byteLength(parts[0], 'utf8');
  const limit = 0.5 * 1048576;
  for (let t = 0; bytes < limit; t += 1) {
    const rows = [];
    for (let r = 0; r < 5; r += 1) {
      rows.push(`| 项目 ${t}-${r} | ${(1000 + r * 137).toLocaleString('en-US')} | ${(2345.67 + r).toFixed(2)} | 说明 ${r} | 备注 ${t} |`);
    }
    const chunk = `## 第 ${t + 1} 张表\n\n| 项目 | 金额 | 单价 | 说明 | 备注 |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n${proseBlock(t)}\n\n`;
    parts.push(chunk);
    bytes += Buffer.byteLength(chunk, 'utf8');
  }
  write('表格密集.md', parts.join(''));
}

/* ---------- 4. Mermaid 密集：100 张流程图（图渲染贵、真实文档数量少） ---------- */
{
  const parts = ['# Mermaid 密集语料（100 张流程图，懒渲染）\n\n'];
  for (let m = 0; m < 100; m += 1) {
    parts.push(
      `## 第 ${m + 1} 张图\n\n\`\`\`mermaid\nflowchart TD\n  A${m}[开始 ${m}] --> B${m}{判断}\n  B${m} -->|是| C${m}[处理]\n  B${m} -->|否| D${m}[跳过]\n  C${m} --> E${m}[结束]\n  D${m} --> E${m}\n\`\`\`\n\n${proseBlock(m)}\n\n`,
    );
  }
  write('Mermaid密集.md', parts.join(''));
}

/* ---------- 5. 长段落：极长段落，无代码/公式/表格/列表 ---------- */
{
  const parts = ['# 长段落语料（无代码、无公式、无表格、无列表）\n\n'];
  for (let p = 0; p < 400; p += 1) {
    parts.push(`${proseBlock(p).repeat(12)}\n\n`);
  }
  write('长段落.md', parts.join(''));
}

/* ---------- 6. 典型用户文档（真实感笔记/报告） ---------- */
{
  write(
    '典型用户文档.md',
    `# 第三季度项目复盘

> 一句话结论：吞吐稳住了，但延迟在月中抖了一次，根因是批处理窗口与备份任务撞车。

## 一、背景

本季度主线是把数据接入从"人工导出"换成"脚本拉取"，覆盖 12 个业务域、约 340 张表。
参与者：数据组 3 人，运维 1 人，业务口径由财务与销售各出 1 人。

## 二、关键动作

1. 统一了字段字典（**口径以财务为准**），把"金额"全部改成 decimal(18,4)；
2. 接入脚本改为**幂等**，重跑不再产生重复行；
3. 加了两个监控：拉取耗时、行数偏差（超过 5% 报警）。

### 2.1 拉取脚本骨架

\`\`\`python
def fetch(domain, day):
    rows = client.query(domain, day)
    if not idempotent_ok(rows):
        raise RuntimeError("行数偏差超阈")
    return normalize(rows)
\`\`\`

### 2.2 幂等键

\`\`\`sql
select domain, biz_date, count(*) as n
from staging.fact_raw
group by 1, 2
having count(*) <> 1
\`\`\`

## 三、指标

| 指标 | 上季 | 本季 | 变化 |
|---|---|---|---|
| 日均拉取耗时 | 42 min | 28 min | −33% |
| 行数偏差告警 | 17 次 | 3 次 | −82% |
| 人工介入 | 21 次 | 6 次 | −71% |
| 失败重跑 | 9 次 | 1 次 | −89% |
| 覆盖业务域 | 4 | 12 | +200% |

单行金额的换算口径见公式：\\( \\text{含税} = \\text{不含税} \\times (1 + r) \\)（r 由财务给定）。

## 四、问题与处理

- **延迟抖动**：月中一次 P95 从 1.2s 涨到 4.8s。定位到备份任务与批处理窗口重叠，
  把备份挪到 02:00 之后恢复；\`cron\` 从 \`0 1 * * *\` 改成 \`0 2 * * *\`。
- **口径反复**：销售想按"发货日"，财务要按"确认日"。最终按财务，销售侧加派生列。

## 五、下一步

- [ ] 把监控接到值班群（当前只有邮件）
- [ ] 12 个域里挑 3 个做"日切校验"试点
- [ ] 把备份窗口写进运维手册，避免再次撞车

## 附：一次典型会话的日志片段

\`\`\`text
[01:00:02] start batch window
[01:00:07] domain=order rows=184223 ok
[01:04:41] domain=invoice rows=98211 ok
[01:12:19] backup task started  <-- 撞车
[01:12:19] domain=stock latency spike
\`\`\`

以上为本季度复盘全文，供下季度对比。
`,
  );
}

console.log(`\n已生成到 ${OUT}`);