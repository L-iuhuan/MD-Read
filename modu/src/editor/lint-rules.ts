/**
 * C1 · Markdown 格式检查——纯函数规则集（与 CM 接线 md-lint.ts 分离，jsdom 无关可单测）。
 * 输入：文本行数组（CM 的 doc.line(i).text，不含行分隔符）；输出：LintIssue[]（中文消息）。
 * 分级契约：error＝结构错误（波浪线＋悬停）；warning＝裸 $…$ 疑似数学（保守启发式，
 * 金额是纯文本**禁止报**）；info＝风格提示（只进徽标＋列表）。
 * 铁律：所有规则先过围栏状态机——围栏内的 #、|、加粗号、$ 一律不算（AGENTS「数结构先排除围栏内部」）。
 * 只读检测：本模块不改写任何内容（无 fix 动作，IME 安全）。
 */

export type LintSeverity = "error" | "warning" | "info";

export interface LintIssue {
  /** 1-based 行号 */
  line: number;
  /** 0-based 起始列 */
  colStart: number;
  len: number;
  severity: LintSeverity;
  /** 中文、面向使用者 */
  message: string;
}

/** 围栏标记：行首 ≤3 空格 + ``` 或 ~~~（GFM 口径） */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** 表格分隔行：| --- | :---: | 形态（前后管壁可选） */
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
/** 列表项：缩进 + `-`/`*`/`+` 或 `1.`（GFM） */
const LIST_RE = /^(\s*)(?:[-*+]|\d+\.)\s+/;
/** 标题：# 到 ###### 后接空白 */
const HEAD_RE = /^(#{1,6})\s/;
/** 裸 $…$ 内容里的「疑似数学」字符：拉丁字母 / \ / ^ / _（金额＝数字千分位货币符，禁报） */
const MATH_CHARS_RE = /[A-Za-z\\^_]/;
/** 引用定义行 [label]: url（链接规则豁免） */
const LINK_DEF_RE = /^\s*\[[^\]]+\]:/;
const LINK_RE = /\[([^\]]*)\]/g;

/** 围栏状态机：inside[i]＝该行在围栏块内（含围栏行本身）；open＝未闭合围栏（EOF 报它） */
function fenceState(lines: readonly string[]): { inside: boolean[]; open: { line: number; col: number; len: number } | null } {
  const inside = new Array<boolean>(lines.length).fill(false);
  let openIdx = -1;
  let marker = "";
  let open: { line: number; col: number; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_RE.exec(lines[i]);
    if (openIdx < 0) {
      if (m !== null) {
        openIdx = i;
        marker = m[1];
        open = { line: i, col: m[0].indexOf(marker[0]), len: marker.length };
        inside[i] = true;
      }
      continue;
    }
    inside[i] = true;
    // 闭合条件：同类标记、不短于开栏、标记后只余空白（GFM 围栏规则）
    if (m !== null && m[1][0] === marker[0] && m[1].length >= marker.length && m[2].trim() === "") {
      openIdx = -1;
      marker = "";
      open = null;
    }
  }
  return { inside, open };
}

/** 行内代码掩码：同一行内反引号之间的字符替换为 \u0000（长度不变，列号保真） */
function maskInlineCode(text: string): string {
  const chars: string[] = [...text];
  let inCode = false;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "`") {
      chars[i] = "\u0000";
      inCode = !inCode;
    } else if (inCode) {
      chars[i] = "\u0000";
    }
  }
  return chars.join("");
}

/** 表格列数：按 | 切分，首尾空管壁的空段不计 */
function tableCols(text: string): number {
  const parts = text.split("|");
  if (text.trimStart().startsWith("|")) parts.shift();
  if (text.trimEnd().endsWith("|")) parts.pop();
  return Math.max(parts.length, 1);
}

/** 找下一个「单个」$（跳过 $$ 的一部分）：金额与定界符共用 $，成块的不进裸 $ 检查 */
function singleDollarAt(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== "$") continue;
    if (text[i - 1] === "$" || text[i + 1] === "$") continue;
    return i;
  }
  return -1;
}

type Collect = (lines: readonly string[], inside: boolean[], out: LintIssue[]) => void;

/** ② 表格：表头 pipe 列数为基准，数据行不符报在该行 */
const collectTables: Collect = (lines, inside, out) => {
  let i = 0;
  while (i < lines.length) {
    const headerOk = !inside[i] && lines[i].includes("|") && i + 1 < lines.length
      && !inside[i + 1] && DELIM_RE.test(lines[i + 1]);
    if (!headerOk) {
      i += 1;
      continue;
    }
    const cols = tableCols(lines[i]);
    let j = i + 2;
    while (j < lines.length && !inside[j] && lines[j].includes("|") && lines[j].trim() !== "") {
      const rowCols = tableCols(lines[j]);
      if (rowCols !== cols) {
        const t = lines[j].trim();
        out.push({ line: j + 1, colStart: lines[j].indexOf(t[0]), len: t.length, severity: "error",
          message: `表格列数不齐：表头 ${cols} 列，此行 ${rowCols} 列` });
      }
      j += 1;
    }
    i = j;
  }
};

/** ③ 块级 $$ 未配对（error）＋ ⑥ 裸 $…$ 疑似数学（warning，保守：宁可漏报不可误报金额） */
const collectDollars: Collect = (lines, inside, out) => {
  let mathLine = -1; // $$ 块开着的起始行（0-based）
  for (let i = 0; i < lines.length; i++) {
    if (inside[i]) continue;
    const text = maskInlineCode(lines[i]);
    let k = text.indexOf("$$"); // ①逐个 $$ 翻转块状态（同行的成对 $$ 自然配平）
    while (k >= 0) {
      mathLine = mathLine < 0 ? i : -1;
      k = text.indexOf("$$", k + 2);
    }
    if (mathLine >= 0) continue; // 块内行不做裸 $ 检查
    let j = singleDollarAt(text, 0);
    while (j >= 0) {
      const close = singleDollarAt(text, j + 1);
      if (close < 0) break; // 单个 $ 无配对：金额常态，不报
      if (MATH_CHARS_RE.test(text.slice(j + 1, close))) {
        out.push({ line: i + 1, colStart: j, len: close - j + 1, severity: "warning",
          message: "疑似数学公式用了 $…$：本项目仅支持 $$…$$ 块级与 \\(…\\) 行内，金额请保持纯文本" });
      }
      j = singleDollarAt(text, close + 1);
    }
  }
  if (mathLine >= 0) {
    out.push({ line: mathLine + 1, colStart: lines[mathLine].indexOf("$$"), len: 2, severity: "error",
      message: "块级公式未配对：缺少结束 $$" });
  }
};

/** ④ 加粗 ** 未配对：行内计数奇数报该行 */
const collectBold: Collect = (lines, inside, out) => {
  for (let i = 0; i < lines.length; i++) {
    if (inside[i]) continue;
    const text = maskInlineCode(lines[i]);
    if ((text.split("**").length - 1) % 2 === 1) {
      out.push({ line: i + 1, colStart: text.indexOf("**"), len: 2, severity: "error",
        message: "加粗标记未配对：此行 ** 数量为奇数" });
    }
  }
};

/** ⑤ 链接残缺：[文本] 后缺 (地址)（后随 [ 的引用链接与脚注 ^ 豁免） */
const collectLinks: Collect = (lines, inside, out) => {
  for (let i = 0; i < lines.length; i++) {
    if (inside[i] || LINK_DEF_RE.test(lines[i])) continue;
    const text = maskInlineCode(lines[i]);
    LINK_RE.lastIndex = 0;
    let m = LINK_RE.exec(text);
    while (m !== null) {
      const after = text[m.index + m[0].length];
      if (after === "[") {
        const closeRef = text.indexOf("]", m.index + m[0].length); // 引用链接 [文本][id]：跳过 id 段
        if (closeRef >= 0) LINK_RE.lastIndex = closeRef + 1;
      } else if (after !== "(" && !m[1].startsWith("^")) {
        out.push({ line: i + 1, colStart: m.index, len: m[0].length, severity: "error",
          message: "链接残缺：[文本] 后缺少 (地址)" });
      }
      m = LINK_RE.exec(text);
    }
  }
};

/** ⑦ 标题跳级：层级差 > 1（首标题不报） */
const collectHeadings: Collect = (lines, inside, out) => {
  let last = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inside[i]) continue;
    const m = HEAD_RE.exec(lines[i]);
    if (m === null) continue;
    const level = m[1].length;
    if (last > 0 && level > last + 1) {
      out.push({ line: i + 1, colStart: 0, len: m[1].length, severity: "info",
        message: `标题跳级：上一标题为 H${last}，此处直接 H${level}` });
    }
    last = level;
  }
};

/** ⑧ 同级列表项缩进不一致：栈式定层，同层首见缩进为基准（info 级容忍启发式误差） */
const collectLists: Collect = (lines, inside, out) => {
  const stack: number[] = [];
  const canon = new Map<number, number>(); // 深度 → 本块首见缩进
  for (let i = 0; i < lines.length; i++) {
    const m = inside[i] ? null : LIST_RE.exec(lines[i]);
    if (m === null) { // 空行/普通文本/围栏行：列表块结束（松散列表保守不比，宁漏报）
      stack.length = 0;
      canon.clear();
      continue;
    }
    const indent = m[1].length;
    while (stack.length > 0 && stack[stack.length - 1] > indent) stack.pop();
    const depth = stack.length;
    if (stack.length === 0 || stack[stack.length - 1] < indent) {
      const first = canon.get(depth);
      if (first !== undefined && first !== indent) {
        const t = lines[i].trim();
        out.push({ line: i + 1, colStart: 0, len: t.length, severity: "info",
          message: `同级列表项缩进不一致：本层此前为 ${first} 空格，此行为 ${indent} 空格` });
      } else {
        canon.set(depth, indent);
      }
      stack.push(indent);
    } // else：同层同缩进，一致 ✓
  }
};

/** 主入口：八条规则全量扫描，按位置排序输出 */
export function lintLines(lines: readonly string[]): LintIssue[] {
  const { inside, open } = fenceState(lines);
  const out: LintIssue[] = [];
  if (open !== null) { // ① 未闭合围栏：EOF 时报在开头围栏行
    out.push({ line: open.line + 1, colStart: open.col, len: open.len, severity: "error",
      message: "代码围栏未闭合：从这行开始的标记到文末没有闭合" });
  }
  collectTables(lines, inside, out);
  collectDollars(lines, inside, out);
  collectBold(lines, inside, out);
  collectLinks(lines, inside, out);
  collectHeadings(lines, inside, out);
  collectLists(lines, inside, out);
  return out.sort((a, b) => a.line - b.line || a.colStart - b.colStart);
}
