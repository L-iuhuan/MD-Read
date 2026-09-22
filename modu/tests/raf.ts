/**
 * P5 批3 测试助手：tabs 的延迟渲染链是双 rAF（whenPainted），
 * 测试用同构双 rAF 冲刷——rAF 回调按注册序 FIFO 执行，tabs 的链先注册，
 * 故冲刷 resolve 时渲染挂载必已发生。jsdom 无 rAF（未开 pretendToBeVisual）
 * 时 whenPainted 退化为同步执行，冲刷随之空操作。
 */
export async function flushed(): Promise<void> {
  if (typeof requestAnimationFrame !== "function") {
    return;
  }
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/** 由 HTML 串造 fragment（模拟管线 fragment 路径的产物形态） */
export function fragOf(html: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const box = document.createElement("div");
  box.innerHTML = html;
  frag.append(...Array.from(box.childNodes));
  return frag;
}
