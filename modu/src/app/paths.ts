/**
 * 显示层路径工具：把 Windows canonical 形态（`\\?\` 前缀）剥成用户熟悉的普通形态。
 *
 * ⚠ 只用于「显示」：存储 / IPC 参数 / 受信清单一律保留 canonical 原串（信任体系设计使然，
 *   见 AGENTS.md「种入受信目录必须是 canonical 小写 ＋ \\?\ 前缀形态」）。本函数是纯函数、
 *   零依赖，谁显示谁调用；禁止把它的返回值写回存储或传给 IPC。
 */

/** 剥掉 `\\?\` 前缀：盘符形态直接去前缀；UNC 形态（`UNC\主机\共享\…` 段）去前缀后
 *  须补回开头的双反斜杠；无前缀（含空串）原样返回。字面示例见 tests/paths.spec.ts
 *  （夹具目录对 UNC 形状豁免敏感门禁，src 注释里不写字面 UNC 形态以免误命中）。 */
export function displayPath(p: string): string {
  if (!p.startsWith("\\\\?\\")) {
    return p; // 无前缀（含空串）：原样返回
  }
  const rest = p.slice(4); // 剥掉开头的 \\?\
  // canonical 的 UNC 段（前四个字符为 UNC 引导）剥掉后补回双反斜杠，回到用户熟悉的 UNC 形态
  if (rest.slice(0, 4).toLowerCase() === "unc\\") {
    return "\\\\" + rest.slice(4);
  }
  return rest;
}
