/**
 * 链接目标裸空格编码（2026-10-01 用户反馈「A 文件指向 B 文件的链接点击跳浏览器」根因修复）。
 *
 * 机理：CommonMark 规定带空格的链接目标必须 `<...>` 包裹；裸空格会让链接解析失败退化成
 * 纯文本，残文里的 `xxx.md` 再被 linkify 当作「域名.md」自动补链成 `http://xn--….md`
 * （punycode）→ 点击 = 外链 → 系统浏览器。中文笔记（文件名含空格/全中文）高发。
 *
 * 修法：md.render 前把 `](dest)` 目标里的裸空格编码为 %20（%20 本就是合法形态，
 * markdown-it 的 normalizeLink 也会这么编）。**围栏内/行内代码内不动**（protectMath 尸检
 * 教训：源码变换必须上下文感知），`<...>` 包裹形态本就合法不动，无 `](` 快速跳过。
 * 引用式定义 `[a]: url` 的空格问题不在本函数范围（罕见，注释存档）。
 *
 * fix-22 缺陷A：目标解析按 CommonMark 链接定义语义支持 `dest "title"` 形态——
 * 题注从目标里剥离、随片段原样保留（markdown-it 正常渲染出 title 属性）；
 * 此前整段 `dest "题注"` 被当作一个目标，题注连空格一起被编进 href/src。
 * 剥离只认 `"…"` / `'…'` 尾部引号题注（题注与目标之间必须隔空白，缺一即视为目标本身）；
 * `(…)` 括号题注**不认**——与 Windows 实路径「文件夹 (2024)」撞车，误拆会把链接改错。
 */

/** 找 line 中 from 起长度恰为 len 的反引号跑（行内代码闭合跑）；找不到返回 -1 */
function findBacktickRun(line: string, from: number, len: number): number {
  for (let i = from; i + len <= line.length; i += 1) {
    if (line[i] !== "`") continue;
    if (line.slice(i, i + len).split("").every((c) => c === "`")) return i;
  }
  return -1;
}

/** 单行变换：行内代码免疫 + `](dest)` 目标空格编码（平衡括号感知） */
function encodeLine(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "`") {
      let run = 0;
      while (line[i + run] === "`") run += 1;
      const close = findBacktickRun(line, i + run, run);
      // 未闭合跑按 CommonMark 不构成代码——保守原样放行（不冒险改写）
      const end = close === -1 ? line.length : close + run;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "]" && line[i + 1] === "(") {
      const t = transformDest(line, i);
      out += t.text;
      i = t.next;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Windows 绝对盘符形态：D:\… 或 D:/…（单字母盘符 + 冒号 + 分隔符） */
function isWindowsAbsolute(dest: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dest);
}

/** s[j] 位置的字面是否被奇数个反斜杠转义 */
function isEscapedAt(s: string, j: number): boolean {
  let backslashes = 0;
  for (let k = j - 1; k >= 0 && s[k] === "\\"; k -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** 剥离出的目标与题注（题注含原引号，如 `"题注"`） */
interface DestTitle {
  dest: string;
  title: string;
}

/**
 * run（`](` 到配对 `)` 的整段）含空白时，尝试把尾部的引号题注剥出来。
 * 从串尾往回找**未转义**的同引号开引号（天然保证题注内部无未转义同引号）；
 * 题注与目标之间必须隔空白，否则该引号属于目标本身（保守不拆）。
 */
function splitTrailingTitle(run: string): DestTitle | null {
  if (!/\s/.test(run)) return null; // 无空白不可能夹题注
  const trimmed = run.replace(/\s+$/, "");
  const quote = trimmed[trimmed.length - 1];
  if (quote !== '"' && quote !== "'") return null;
  for (let j = trimmed.length - 2; j >= 0; j -= 1) {
    if (trimmed[j] !== quote || isEscapedAt(trimmed, j)) continue;
    const rawPrefix = run.slice(0, j);
    const dest = rawPrefix.replace(/\s+$/, "");
    // 引号贴着目标（无空白隔开）或目标为空 = 该引号属于目标本身，保守不拆
    if (dest === "" || !/\s$/.test(rawPrefix)) return null;
    return { dest, title: trimmed.slice(j) };
  }
  return null;
}

/** line[from] 起（允许前导空白）的引号题注；返回含引号原文与结束位（供 `)` 配对判定） */
function quotedTitleAfter(line: string, from: number): { text: string; end: number } | null {
  let i = from;
  while (line[i] === " " || line[i] === "\t") i += 1;
  const quote = line[i];
  if (quote !== '"' && quote !== "'") return null;
  for (let j = i + 1; j < line.length; j += 1) {
    if (line[j] === "\\") { j += 1; continue; } // 转义对：整体越过
    if (line[j] === quote) return { text: line.slice(i, j + 1), end: j + 1 };
  }
  return null;
}

/**
 * 从 openIdx（指向 `]`）处理一个链接/图片目标；返回改写后的片段与继续扫描位。
 * next 始终是**原行**坐标（此前重写分支用改写产物长度推进，改写变长时会跳过原文——顺修）。
 */
function transformDest(line: string, openIdx: number): { text: string; next: number } {
  let i = openIdx + 2; // 跳过 `](`
  if (line[i] === "<") return transformAngleDest(line, openIdx, i);
  let depth = 0;
  const start = i;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") { i += 2; continue; } // 转义对：整体越过
    if (c === "(") { depth += 1; i += 1; continue; }
    if (c === ")" && depth === 0) break;
    if (c === ")") { depth -= 1; i += 1; continue; }
    i += 1;
  }
  if (i >= line.length) {
    // 行内没有闭合括号：非完整链接形态，原样放行
    return { text: line.slice(openIdx), next: line.length };
  }
  const run = line.slice(start, i);
  const split = splitTrailingTitle(run);
  if (split !== null) {
    const destOut = isWindowsAbsolute(split.dest)
      ? `<file:///${toFileUrl(split.dest)}>`
      : split.dest.replace(/ /g, "%20");
    return { text: `](${destOut} ${split.title})`, next: i + 1 };
  }
  if (isWindowsAbsolute(run)) {
    // D:\a b.md / D:/a b.md（无协议）→ file:///（空格同步编码），
    // 否则 DOMPurify 按「d: 陌生 scheme」摘 href → 死链
    return { text: `](file:///${toFileUrl(run)})`, next: i + 1 };
  }
  if (!run.includes(" ")) return { text: line.slice(openIdx, i + 1), next: i + 1 };
  return { text: `](${run.replace(/ /g, "%20")})`, next: i + 1 };
}

/**
 * `<...>` 包裹形态：本就允许空格；非盘符路径原样放行（题注字符随后续扫描自然流过）。
 * 盘符路径重写为 file:///（否则被 DOMPurify 当 scheme 摘掉 href），
 * `>` 之后直接 `)` 或 `ws+题注+ws+)` 才算完整链接并整体重写（fix-22 缺陷A：题注保留）；
 * 其余残缺形态只放行 `](<…>`，与既有口径一致。
 */
function transformAngleDest(line: string, openIdx: number, open: number): { text: string; next: number } {
  const close = line.indexOf(">", open);
  if (close === -1) return { text: line.slice(openIdx), next: line.length };
  const inner = line.slice(open + 1, close);
  if (!isWindowsAbsolute(inner)) {
    const after = line[close + 1] === ")" ? close + 2 : close + 1;
    return { text: line.slice(openIdx, after), next: after };
  }
  let end = -1;
  let titlePart = "";
  if (line[close + 1] === ")") {
    end = close + 2;
  } else {
    const t = quotedTitleAfter(line, close + 1);
    if (t !== null) {
      let e = t.end;
      while (line[e] === " " || line[e] === "\t") e += 1;
      if (line[e] === ")") { end = e + 1; titlePart = ` ${t.text}`; }
    }
  }
  if (end === -1) return { text: line.slice(openIdx, close + 1), next: close + 1 };
  return { text: `](<file:///${toFileUrl(inner)}>${titlePart})`, next: end };
}

/** 盘符路径 → file:/// URL 片段：反斜杠转正斜杠 + 空格编码（其余交给 normalizeLink） */
function toFileUrl(dest: string): string {
  return dest.replace(/\\/g, "/").replace(/ /g, "%20");
}

/** 围栏 + 行内代码免疫的链接目标空格编码（纯函数；无 `](` 时零成本直通） */
export function encodeLinkDestSpaces(src: string): string {
  if (!src.includes("](")) return src;
  const lines = src.split("\n");
  let fence: { marker: string; len: number } | null = null;
  const out: string[] = [];
  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      out.push(line);
      if (fenceMatch !== null && fenceMatch[1][0] === fence.marker && fenceMatch[1].length >= fence.len) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch !== null) {
      fence = { marker: fenceMatch[1][0], len: fenceMatch[1].length };
      out.push(line);
      continue;
    }
    out.push(encodeLine(line));
  }
  return outLines(out);
}

/** join 包装（测试桩点：便于断言行边界行为） */
function outLines(lines: string[]): string {
  return lines.join("\n");
}
