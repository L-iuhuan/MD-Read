/**
 * 「真实长文不丢内容」锚（2026-09-27 补，阶段② 内容正确性）。
 *
 * ## 为什么需要它
 * 之前判"渲染对不对"用的是一次性 CDP 探针，判据**连错三次** ✗：
 *   ① 用 `doc.innerText` 取文本 —— 它会被 `content-visibility: auto` **跳过的子树清空**
 *      ⇒ 实测同一份文档 `innerText` 只有 2305 字、而 `textContent` 有 9554 字（源 10396）✗
 *      ⇒ 当时报出"48 个标题找不到"，**是假象** ✓（换 `textContent` 后 27/27 全中 ✓）
 *   ② 拿**源码原文**去比对**渲染后文本**（`1. **项目管理**：…` vs `项目管理：…`）✗
 *      ⇒ 报出 9 条"缺失"，全部是语法差异造成的假象 ✗
 *   ③ 只数结构（块数/表数），没有"逐行内容都在"的判据 ⇒ 丢一行也不会红 ✗
 * ⇒ 本文件把判据固化成锚：**剥掉 markdown 语法后，源里每一行实质文本都必须能在
 *   渲染结果里找到** ✓ —— 这条对**任何**文档都成立，不再依赖一次性探针 ✓
 *
 * ## 写这个锚时**又**踩的三个坑（都记在这里，防复发 ✗）
 *   ④ 数 `#` 标题时**没有排除围栏内部**：bash 代码块里的注释 `# 生成索引` 被当成了标题 ✗
 *      （渲染器做得对 —— 它不把围栏里的 `#` 当标题 ✓ ⇒ **错的是锚** ✓）
 *   ⑤ 夹具里写了"行内码包着的 `<br>`"：`stripTags` 先删标签 ⇒ 期望串残留空反引号对 ⇒ 假红 ✗
 *   ⑥ ⭐ **假设"行内 HTML 会渲染成元素"是错的** ✗ —— 本项目**明令禁止** `html:true` ✓
 *      ⇒ HTML 一律**转义成字面文本** ✓（这是安全正面性质 ✓）⇒ 断言应钉"转义"，不是钉"渲染" ✓
 *
 * ⚠ 夹具 `corpus/真实长文-不规则.md` 是从用户真实文档**蒸馏形态**而来（原文不入库 ✓）。
 */
import { describe, expect, it } from "vitest";
import { renderDocument } from "../src/render/pipeline";
import fixtureSrc from "./corpus/真实长文-不规则.md?raw";

const src: string = fixtureSrc;
const { html, outline } = renderDocument(src);
const doc = new DOMParser().parseFromString(html, "text/html");
const text = doc.body.textContent ?? "";

/**
 * 把一行 markdown 还原成"渲染后应该出现的文本"。
 * ⚠ 表格行与代码围栏**不在适用范围**（调用处跳过，另用结构计数覆盖 ✓）。
 * ⚠ 这里**不剥 HTML 标签**（与"HTML 一律转义成字面文本"那条锚同源 ✓）：
 *    本项目禁用 `html:true` ⇒ `<kbd>Ctrl</kbd>` 在渲染结果里就是**这串字面文本** ✓。
 *    反过来说：早先版本先 `stripTags` 再处理行内码，等于对同一份渲染结果用了**两套相反假设**
 *    ⇒ 必然假红 ✗（本批实测连红两轮才定位 ✓）。
 */
function plainOf(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "") // 标题
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "") // 任务列表
    .replace(/^\s*[-*+]\s+/, "") // 无序列表
    .replace(/^\s*\d+\.\s+/, "") // 有序列表
    .replace(/^\s*>\s?/, "") // 引用
    .replace(/\*\*([^*]+)\*\*/g, "$1") // 粗体
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2") // 斜体
    .replace(/`([^`]+)`/g, "$1") // 行内码 ⇒ 去掉反引号，内容原样保留（含 `<br>` 这类字面标签 ✓）
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接 ⇒ 只留文字
    .replace(/^\s*---+\s*$/, "") // 分隔线
    .trim();
}

/** 逐行遍历源，带**围栏状态**（坑④：围栏内的 `#` 不是标题 ✓） */
function walk(source: string, visit: (line: string, inFence: boolean) => void): void {
  let inFence = false;
  for (const raw of source.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    visit(raw, inFence);
  }
}

/** 该出现的实质文本（跳过表格行 / 围栏内 / 过短行） */
function expectedLines(source: string): string[] {
  const out: string[] = [];
  walk(source, (raw, inFence) => {
    if (inFence || /^\s*\|/.test(raw)) {
      return;
    }
    const p = plainOf(raw);
    if (p.length >= 6) {
      out.push(p);
    }
  });
  return out;
}

/** 真正的标题行（**排除围栏内部** ✓） */
function headingLines(source: string): string[] {
  const out: string[] = [];
  walk(source, (raw, inFence) => {
    if (!inFence && /^#{1,6} /.test(raw)) {
      out.push(plainOf(raw));
    }
  });
  return out;
}

describe("真实长文不丢内容（剥语法后逐行比对）", () => {
  const expected = expectedLines(src);
  const heads = headingLines(src);

  it("夹具本身够「不规则」（否则这条锚没有意义）", () => {
    const lines = src.split(/\r?\n/);
    expect(lines.filter((l) => /^#{1,6} /.test(l)).length).toBeGreaterThanOrEqual(5);
    expect(lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length).toBeGreaterThanOrEqual(5);
    expect(lines.filter((l) => /^```/.test(l)).length).toBeGreaterThanOrEqual(4);
    expect(lines.filter((l) => /<[a-zA-Z/][^>]*>/.test(l)).length).toBeGreaterThanOrEqual(3);
  });

  it("⭐ 源里每一行实质文本都能在渲染结果里找到（这条才是「不丢内容」 ✓）", () => {
    expect(expected.length).toBeGreaterThanOrEqual(15); // 别让锚退化成"空数组恒真" ✗
    const missing = expected.filter((line) => !text.includes(line));
    expect(missing, `以下行在渲染结果里找不到：\n${missing.join("\n")}`).toEqual([]);
  });

  it("标题文本一个不少（排除围栏内 ⇒ 坑④）", () => {
    expect(heads.length).toBeGreaterThanOrEqual(5);
    const bad = heads.filter((h) => !text.includes(h));
    expect(bad, `标题丢了：\n${bad.join("\n")}`).toEqual([]);
    expect(outline.length).toBeGreaterThanOrEqual(heads.length);
    // 反向锚：围栏里那句注释「生成索引（幂等）」**不许**进大纲 ✓
    expect(outline.map((o) => o.text).join("|")).not.toContain("生成索引");
  });

  it("⭐ HTML 一律**转义成字面文本**（禁用 html:true ⇒ 安全正面性质 ✓，坑⑥）", () => {
    expect(doc.querySelectorAll("details").length).toBe(0);
    expect(doc.querySelectorAll("kbd").length).toBe(0);
    expect(doc.querySelectorAll("em").length).toBe(0);
    expect(text).toContain("<details>");
    expect(text).toContain("</details>");
    for (const frag of ["Ctrl", "为什么不用第三方图谱库", "打包体积", "三条都不满足"]) {
      expect(text, `HTML 行里的可见文本丢了：${frag}`).toContain(frag);
    }
  });

  it("结构计数与源一致（表格 / 代码段 / 列表项）", () => {
    const lines = src.split(/\r?\n/);
    const separators = lines.filter((l) => /^\s*\|[\s:|-]+\|\s*$/.test(l)).length;
    const tableRows = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l)).length;
    const fences = lines.filter((l) => /^```/.test(l)).length;
    let mdListItems = 0;
    let mdQuotes = 0;
    let prevQuote = false;
    walk(src, (raw, inFence) => {
      const isItem = !inFence && /^\s*([-*+]|\d+\.)\s/.test(raw);
      if (isItem) {
        mdListItems += 1;
      }
      // 引用块按"**连续引用行为一块**"计数（markdown-it 就是这么合并的 ✓）
      // —— 第一次红是因为我只按 1 算，而夹具里有两处引用（文件头说明 + 正文）✗
      const isQuote = !inFence && /^\s*>/.test(raw);
      if (isQuote && !prevQuote) {
        mdQuotes += 1;
      }
      prevQuote = isQuote;
    });
    const got = {
      table: doc.querySelectorAll("table").length,
      tr: doc.querySelectorAll("tr").length,
      pre: doc.querySelectorAll("pre").length,
      li: doc.querySelectorAll("li").length,
      blockquote: doc.querySelectorAll("blockquote").length,
      hr: doc.querySelectorAll("hr").length,
    };
    const want = {
      table: 1,
      tr: tableRows - separators,
      pre: fences / 2,
      li: mdListItems,
      blockquote: mdQuotes,
      hr: 1,
    };
    // 诊断写进断言消息：红了能一眼看出差在哪一项 ✓（本批第一次红时消息被截断，只能靠推理 ✗）
    expect(
      got,
      `结构计数不符 —— 渲染得到 ${JSON.stringify(got)} / 源推算 ${JSON.stringify(want)}` +
        `（源：${tableRows} 表格行 / ${separators} 分隔行 / ${fences} 围栏 / ${mdListItems} 列表项）`,
    ).toEqual(want);
  });

  it("金额与符号不被改写（与 typographer:false 的裁决同源 ✓）", () => {
    for (const frag of ["$1,000", "$2,000", "1--2", "--flag", '"key": value']) {
      expect(text, `符号被改写了：${frag}`).toContain(frag);
    }
  });
});
