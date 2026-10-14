/**
 * 中文文本整理（编辑增强 B1）：源码文本级的「CJK ↔ 拉丁/数字/货币」补单空格。
 *
 * 判定与阅读侧 render/pangu.ts 的 RE_BOUNDARY 同源（改判定须两处同批改）；
 * 实现是**源码文本变换**（直接产出文档变更），不复用渲染管线的 DOM 版。
 *
 * 语法安全（保守豁免，宁漏勿错）：
 * · 围栏代码块（```/~~~ 开闭状态机，含围栏行本身）与缩进 ≥4 空格的缩进代码行：整行跳过；
 * · $$ 公式行（块级，含内部行）整行跳过；行内 \(…\) 区间跳过；
 * · 行内代码：等长反引号 run 配对区间跳过（CommonMark：不同长度不互闭；未闭合豁免到行尾）；
 * · 链接/图片目标 ](…) 括号区间跳过（链接文字本身仍整理）；
 * · 链接引用定义行（[label]: url）整行跳过——插空会改 label 破坏引用匹配；
 * · 文首 frontmatter（--- … ---）整段跳过。
 *
 * 取舍：全角标点规范化**刻意不做**——自动改标点违背 typographer:false 的项目精神
 * （不静默改有字面含义的文本）；本命令只做「补间距」这一无歧义变换。
 *
 * CRLF（D7）：纯插入（只插空格、零删改既有字节），行分隔符天然保真。
 */
import { type Command, EditorView } from "@codemirror/view";
import { startsDisplayMath } from "./live-preview";
import type { Line } from "@codemirror/state";

/** CJK 侧字符（与 render/pangu.ts 的 RE_BOUNDARY 同源：部首~汉字 + 兼容表意） */
function isCjk(ch: string): boolean {
  return (ch >= "\u2e80" && ch <= "\u9fff") || (ch >= "\uf900" && ch <= "\ufaff");
}

/** 拉丁/数字/货币侧（同源：货币符号只在 CJK 边界参与，$1,000 内部永不被拆） */
function isLatin(ch: string): boolean {
  return /[A-Za-z0-9$¥€£＄￥]/.test(ch);
}

/** 行内豁免区间（行内坐标 [start, end)）：反引号码区间、](…) 目标、\(…\) 行内公式 */
function inlineExemptions(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  // ① 反引号 run 收集，等长配对（不同长度不互闭；未闭合豁免到行尾）
  const runs: Array<{ at: number; len: number }> = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let len = 0;
    while (text[i + len] === "`") {
      len++;
    }
    runs.push({ at: i, len });
    i += len;
  }
  let open: { at: number; len: number } | null = null;
  for (const run of runs) {
    if (open === null) {
      open = run;
    } else if (run.len === open.len) {
      out.push([open.at, run.at + run.len]);
      open = null;
    }
  }
  if (open !== null) {
    out.push([open.at, text.length]);
  }
  // ② 链接/图片目标与行内公式：](… → 配对 ) ；\( … → 配对 \)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "]" && text[i + 1] === "(") {
      const close = text.indexOf(")", i + 2);
      const end = close === -1 ? text.length : close + 1;
      out.push([i + 1, end]);
      i = end - 1;
    } else if (text[i] === "\\" && text[i + 1] === "(") {
      const close = text.indexOf("\\)", i + 2);
      const end = close === -1 ? text.length : close + 2;
      out.push([i, end]);
      i = end - 1;
    }
  }
  return out;
}

/** 单行边界扫描：产出该行落在 [from, to] 内的空格插入点（行内豁免区间跳过） */
function lineInserts(line: Line, from: number, to: number): Array<{ from: number; insert: string }> {
  const text = line.text;
  const exempt = inlineExemptions(text);
  const inExempt = (pos: number): boolean => exempt.some(([s, e]) => pos >= s && pos < e);
  const out: Array<{ from: number; insert: string }> = [];
  for (let i = 0; i + 1 < text.length; i++) {
    const a = text[i];
    const b = text[i + 1];
    const boundary = (isCjk(a) && isLatin(b)) || (isLatin(a) && isCjk(b));
    if (!boundary || inExempt(i) || inExempt(i + 1)) {
      continue;
    }
    const p1 = line.from + i; // 成对字符的绝对位置：两者都要落在目标区间内
    const p2 = p1 + 1;
    if (p1 >= from && p2 <= to) {
      out.push({ from: p2, insert: " " });
    }
  }
  return out;
}

/** 是否 $$ 公式行（块级 display math 的开/关行，或 $$…$$ 单行）。
 *  守卫与 live-preview 同源（startsDisplayMath）：剥掉引用栈/缩进/列表标记后
 *  以 $$ 开头——`> $$`、`- $$`、`1. $$` 与列首同判。旧实现只认 trimStart 后
 *  的列首形态，会往引用/列表内的公式体插空格（切阅读态公式被改写）；
 *  对照锚：tests/editor-audit-text-cleanup.spec.ts。 */
function isMathFenceLine(text: string): boolean {
  return startsDisplayMath(text);
}

/** $$ 出现次数为奇数 ⇒ 块级公式从此行开启（单行 $$…$$ 为偶数，不开启） */
function togglesMathBlock(text: string): boolean {
  let count = 0;
  for (let i = text.indexOf("$$"); i !== -1; i = text.indexOf("$$", i + 2)) {
    count++;
  }
  return count % 2 === 1;
}

/**
 * 中文整理命令（键位 Ctrl-Shift-T，绑定点在 editor.ts）：对选区（无选区=全文）
 * 补 CJK ↔ 拉丁间距；无命中返回 false（不产生空事务、不碰撤销链）。
 */
export const tidyChineseText: Command = (view: EditorView): boolean => {
  const { state } = view;
  const main = state.selection.main;
  const from = main.empty ? 0 : main.from;
  const to = main.empty ? state.doc.length : main.to;
  const firstLine = state.doc.lineAt(from).number;
  const lastLine = state.doc.lineAt(to).number;
  const inserts: Array<{ from: number; insert: string }> = [];
  let fence: string | null = null; // 围栏字符（` 或 ~），null = 不在围栏内
  let fenceLen = 0;
  let mathBlock = false;
  const hasFrontmatter = state.doc.line(1).text.trim() === "---";
  let frontmatterOpen = hasFrontmatter;
  for (let n = 1; n <= lastLine; n++) {
    const line = state.doc.line(n);
    const text = line.text;
    if (frontmatterOpen) {
      if (n > 1 && (text.trim() === "---" || text.trim() === "...")) {
        frontmatterOpen = false; // 关闭行也整行跳过
      }
      continue;
    }
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fence !== null) {
      if (fenceMark !== null && fenceMark[1][0] === fence && fenceMark[1].length >= fenceLen) {
        fence = null; // 闭合围栏行
      }
      continue; // 围栏内部与围栏行本身：整行跳过
    }
    if (mathBlock) {
      if (isMathFenceLine(text) && togglesMathBlock(text)) {
        mathBlock = false; // $$ 关闭行
      }
      continue;
    }
    if (fenceMark !== null) {
      fence = fenceMark[1][0];
      fenceLen = fenceMark[1].length;
      continue; // 开启围栏行
    }
    if (isMathFenceLine(text)) {
      if (togglesMathBlock(text)) {
        mathBlock = true; // 块级公式开启；本行与后续行都跳过
      }
      continue; // 单行 $$…$$ 同样整行跳过
    }
    if (/^ {4,}\S/.test(text)) {
      continue; // 缩进代码块（保守：深缩进续行宁可漏整理）
    }
    if (/^ {0,3}\[[^\]]*\]:/.test(text)) {
      continue; // 链接引用定义行
    }
    if (n >= firstLine) {
      inserts.push(...lineInserts(line, from, to));
    }
  }
  if (inserts.length === 0) {
    return false;
  }
  view.dispatch({ changes: inserts });
  return true;
};
