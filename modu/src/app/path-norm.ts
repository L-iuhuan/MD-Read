/**
 * 路径形态归一的**前端唯一调用点**（本轮修复：同一文件两种路径形态 ⇒ 标签重复）。
 *
 * **归一实现不在前端**：`canonicalize` 只有 Rust 侧能做（确定性、跨通道同源），全仓
 * 唯一实现在 `src-tauri/src/fs.rs` 的 `normalize_path`（函数），经同名族的 IPC 命令
 * `canonical_path` 暴露（命令名不能与那个函数同名：Rust 函数与 `#[tauri::command]` 宏
 * 共用值命名空间，同名会 `E0428`）。本模块只是那一个实现的**调用者** —— 禁止在前端复刻
 * 一套"看起来差不多"的归一（两份实现迟早分叉，而标签去重恰恰是靠"两端产出的串逐字相等"
 * 成立的）。
 *
 * 为什么前端还需要这一层：OS 拖放（`getCurrentWebview().onDragDropEvent`）给的是**原始串**，
 * 它不经原生对话框、也不经 argv ⇒ 绕过了 `md_paths` 的归一；`modu-recent` 里还存着历史
 * 双形态的值。两处都必须在**路径第一次进入标签层之前**收敛。
 */
import { invoke } from "@tauri-apps/api/core";

/** 单条路径归一（返回值 = Rust `canonical_path` 命令的产物；失败路径原样返回）。 */
export function normalizePath(raw: string): Promise<string> {
  return invoke<string>("canonical_path", { raw });
}

/**
 * 批量归一（拖放一次可能给多个路径）：**并发**调同一条命令，保持输入顺序。
 * 顺序必须保住 —— 多文件打开「仅末项激活渲染」的语义依赖列表顺序（见 app/drop.ts）。
 */
export async function normalizePaths(paths: string[]): Promise<string[]> {
  return Promise.all(paths.map((path) => normalizePath(path)));
}
