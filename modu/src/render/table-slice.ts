/**
 * T4 分栏切片器（四档宽表导出策略，2026-10-15 主人批准；档位判据在 print-ready.ts）。
 *
 * 输入 `.table-wrap` 里的原表（GFM 渲染产物），在 wrap 内**追加**一个 `.slice-stack`
 * （带 hidden：屏显退场，打印态由 print.css 显现——原表永远留在 DOM，屏显与
 * blockContentWidth 的重测口径不变）。stack 内含 M 个独立 `<table class="slice-seg">`：
 * - 切片前把 colspan/rowspan 拆平成规整网格：内容复制到各占位格（`data-slice-flatten`），
 *   只动克隆段、不动原表；
 * - 每段带完整 thead ⇒ 跨页表头重复由全局 `thead{display:table-header-group}` 原生接管；
 * - 第 2 段起重复首列（标识列），重复格标 `data-slice-repeat`；
 * - 段间分隔取舍：**段前小标题「续表 N/共 M」**而非细分隔线——段会各自分页，
 *   细线只在两段同页相邻时才有意义，小标题在任何落页形态下都自解释。
 *
 * 幂等/还原：restoreSlicedTables 清掉 stack 与 `table-sliced` 类（markPrintBlocks 每轮
 * 开头调用，先还原再重判 ⇒ 重跑不叠加）；sliceTableWrap 自身入口也先清本 wrap 旧产物。
 * 导出取消后 DOM 里只剩 hidden 的 stack（屏显零影响），下一轮标记或换文档重渲时清干净。
 */

/** 每段目标宽上限：261mm（横版可印宽）≈ 987px@96dpi，留 ~37px≈10mm 余量防四舍五入贴边
 *  裁切。与 print.css 的 calc(261mm - 2mm)（那边再留 2mm 安全边）同源耦合，改任一边
 *  必须同步另一边注释。 */
export const SLICE_SEGMENT_BUDGET_PX = 950

interface GridSlot {
  /** 占位格的内容来源（跨格时多个槽指向同一源格；copy=true 的是拆平复制件） */
  source: HTMLTableCellElement
  copy: boolean
}

interface TableGrid {
  slots: (GridSlot | undefined)[][]
  rowCount: number
  columnCount: number
  /** thead 行数（段内 thead 克隆范围；GFM 恒 1） */
  headRows: number
}

function isCell(el: Element): el is HTMLTableCellElement {
  return el.tagName === 'TH' || el.tagName === 'TD'
}

/** 拆平 colspan/rowspan 为规整网格（HTML 表格占位算法：行指针跳过已被跨格占用的列） */
function flattenToGrid(table: HTMLTableElement): TableGrid {
  const rows = Array.from(table.querySelectorAll('tr'))
  const headRows = table.querySelectorAll('thead tr').length
  const slots: (GridSlot | undefined)[][] = []
  rows.forEach((tr, r) => {
    let col = 0
    for (const cell of Array.from(tr.children).filter(isCell)) {
      while (slots[r]?.[col] !== undefined) {
        col += 1
      }
      const spanCols = Math.max(1, cell.colSpan)
      const spanRows = Math.max(1, cell.rowSpan)
      for (let dr = 0; dr < spanRows; dr++) {
        for (let dc = 0; dc < spanCols; dc++) {
          if (slots[r + dr] === undefined) {
            slots[r + dr] = []
          }
          slots[r + dr]![col + dc] = { source: cell, copy: !(dr === 0 && dc === 0) }
        }
      }
      col += spanCols
    }
  })
  const columnCount = slots.reduce((max, row) => Math.max(max, row.length), 0)
  return { slots, rowCount: rows.length, columnCount, headRows: Math.max(1, headRows) }
}

/**
 * 各列 min-content 宽（贪心分组用它把「每段 ≤950px」落到位）：
 * 真浏览器——临时 inline-size:min-content（与 blockContentWidth 同款手法）后逐格读宽、
 * 跨格按 colspan 均摊、按列取最大，最后归一到实测自然宽（消除量测残差）；
 * jsdom 无布局（读数恒 0）⇒ 等宽回退（每列 = 自然宽/列数，测试口径确定性）。
 */
function measureColumnWidths(
  table: HTMLTableElement,
  columnCount: number,
  naturalWidth: number,
): number[] {
  const widths = new Array<number>(columnCount).fill(0)
  const previous = table.style.inlineSize
  table.style.inlineSize = 'min-content'
  for (const row of Array.from(table.rows)) {
    let col = 0
    for (const cell of Array.from(row.cells)) {
      const span = Math.max(1, cell.colSpan)
      const each = cell.getBoundingClientRect().width / span
      for (let k = 0; k < span && col + k < columnCount; k++) {
        widths[col + k] = Math.max(widths[col + k]!, each)
      }
      col += span
    }
  }
  table.style.inlineSize = previous
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (total <= 0) {
    return widths.map(() => naturalWidth / columnCount)
  }
  return widths.map((w) => (w / total) * naturalWidth)
}

/** 纯函数：贪心列分组。非首段起段时把标识列（首列）宽度计入预算；单列自身超预算也
 *  独立成段（保证推进，段内压列由 squeeze-page 的 261mm 规则兜底）。 */
export function groupColumns(widths: number[], budget: number, repeatWidth: number): number[][] {
  const groups: number[][] = []
  let current: number[] = []
  let used = 0
  for (let i = 0; i < widths.length; i++) {
    const w = Math.max(0, widths[i] ?? 0)
    if (current.length > 0 && used + w > budget) {
      groups.push(current)
      current = []
      used = 0
    }
    if (current.length === 0 && groups.length > 0) {
      used += repeatWidth // 第 2 段起：重复的标识列占宽
    }
    current.push(i)
    used += w
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

function cloneCell(slot: GridSlot | undefined, col: number, repeatIdentity: boolean): HTMLTableCellElement {
  if (slot === undefined) {
    return document.createElement('td') // 防御：参差表（GFM 不会产出）补空格
  }
  const clone = slot.source.cloneNode(true) as HTMLTableCellElement
  if (slot.copy) {
    clone.dataset.sliceFlatten = '' // 跨格拆平复制件
  }
  if (repeatIdentity && col === 0) {
    clone.dataset.sliceRepeat = '' // 标识列重复
  }
  return clone
}

/** 造一段：克隆网格行中该组列的格子（thead 完整行；第 2 段起前置标识列克隆） */
function buildSegmentTable(grid: TableGrid, columns: number[], repeatIdentity: boolean): HTMLTableElement {
  const table = document.createElement('table')
  table.className = 'slice-seg'
  const columnList = repeatIdentity ? [0, ...columns.filter((c) => c !== 0)] : columns
  const head = document.createElement('thead')
  const body = document.createElement('tbody')
  for (let r = 0; r < grid.rowCount; r++) {
    const tr = document.createElement('tr')
    for (const col of columnList) {
      tr.appendChild(cloneCell(grid.slots[r]?.[col], col, repeatIdentity))
    }
    ;(r < grid.headRows ? head : body).appendChild(tr)
  }
  table.append(head, body)
  return table
}

function buildCaption(index: number, total: number): HTMLElement {
  const p = document.createElement('p')
  p.className = 'slice-caption'
  p.dataset.sliceIndex = String(index)
  p.dataset.sliceTotal = String(total)
  p.textContent = `续表 ${index}/${total}`
  return p
}

/**
 * 给一个 T4 wrap 建切片（wrap 需已是 .squeeze-page：横排页＋261mm 压列对每段同样生效，
 * print.css 的 `.mdc .squeeze-page table` 选择器天然覆盖 stack 内的段表）。
 * 返回段数；列数 <2 或一段就装得下时返回 0（不切，退回 T3 形态）。
 */
export function sliceTableWrap(wrap: HTMLElement, naturalWidth: number): number {
  wrap.querySelector('.slice-stack')?.remove() // 自幂等：重切先清本 wrap 旧产物
  wrap.classList.remove('table-sliced')
  const table = wrap.querySelector('table')
  if (!(table instanceof HTMLTableElement)) {
    return 0
  }
  const grid = flattenToGrid(table)
  if (grid.columnCount < 2) {
    return 0
  }
  const widths = measureColumnWidths(table, grid.columnCount, naturalWidth)
  const groups = groupColumns(widths, SLICE_SEGMENT_BUDGET_PX, widths[0] ?? 0)
  if (groups.length < 2) {
    return 0
  }
  const stack = document.createElement('div')
  stack.className = 'slice-stack'
  stack.hidden = true
  groups.forEach((columns, i) => {
    if (i > 0) {
      stack.appendChild(buildCaption(i + 1, groups.length))
    }
    stack.appendChild(buildSegmentTable(grid, columns, i > 0))
  })
  wrap.appendChild(stack)
  wrap.classList.add('table-sliced')
  return groups.length
}

/** 幂等还原：清掉全部切片产物（stack 整体移除＋table-sliced 类摘除）。原表从未被动过。
 *  root 自身是 .table-sliced wrap 时也在还原之列（querySelectorAll 只搜后代）。 */
export function restoreSlicedTables(root: ParentNode): void {
  for (const stack of Array.from(root.querySelectorAll('.slice-stack'))) {
    stack.remove()
  }
  const wraps = Array.from(root.querySelectorAll('.table-sliced'))
  if (root instanceof Element && root.classList.contains('table-sliced')) {
    wraps.unshift(root)
  }
  for (const wrap of wraps) {
    wrap.classList.remove('table-sliced')
  }
}
