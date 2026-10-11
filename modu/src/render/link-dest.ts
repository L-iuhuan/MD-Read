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
      out += transformDest(line, i).text;
      i = transformDest(line, i).next;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 从 openIdx（指向 `]`）处理一个链接/图片目标；返回改写后的片段与继续扫描位 */
function transformDest(line: string, openIdx: number): { text: string; next: number } {
  let i = openIdx + 2; // 跳过 `](`
  if (line[i] === "<") {
    // <...> 包裹形态：本就允许空格；但 Windows 绝对盘符形态（<D:\a b.md>）会被
    // DOMPurify 当 scheme 摘掉 href（2026-10-01 实测），同样重写为 file:/// 再放行
    const close = line.indexOf(">", i);
    if (close === -1) return { text: line.slice(openIdx), next: line.length };
    const inner = line.slice(i + 1, close);
    if (isWindowsAbsolute(inner)) {
      const rewritten = `](<file:///${toFileUrl(inner)}>)`;
      return { text: rewritten, next: openIdx + rewritten.length };
    }
    const after = line[close + 1] === ")" ? close + 2 : close + 1;
    return { text: line.slice(openIdx, after), next: after };
  }
  let depth = 0;
  const start = i;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\") { i += 2; continue; } // 转义对：整体越过
    if (c === "(") { depth += 1; i += 1; continue; }
    if (c === ")") {
      if (depth > 0) { depth -= 1; i += 1; continue; }
      const dest = line.slice(start, i);
      if (isWindowsAbsolute(dest)) {
        // D:\a b.md / D:/a b.md（无协议）→ file:///（空格同步编码），
        // 否则 DOMPurify 按「d: 陌生 scheme」摘 href → 死链
        const rewritten = `](file:///${toFileUrl(dest)})`;
        return { text: rewritten, next: openIdx + rewritten.length };
      }
      if (!dest.includes(" ")) return { text: line.slice(openIdx, i + 1), next: i + 1 };
      const encoded = dest.replace(/ /g, "%20");
      return { text: `](${encoded})`, next: i + 1 };
    }
    i += 1;
  }
  // 行内没有闭合括号：非完整链接形态，原样放行
  return { text: line.slice(openIdx), next: line.length };
}

/** Windows 绝对盘符形态：D:\… 或 D:/…（单字母盘符 + 冒号 + 分隔符） */
function isWindowsAbsolute(dest: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(dest);
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
