/// <reference types="vite/client" />

/**
 * 开发期真机探针入口（D-05 多标签验收）：只在 vite dev（`import.meta.env.DEV`）下
 * 由 main.ts 的 boot() 挂载，生产构建里恒为 undefined。
 * 用途：CDP 探针要**真的走 read_file** 打开草稿副本（受控语料不能被自动保存写回），
 * 而磁盘上的文件只能经这条真实读文件链进到标签里。
 */
interface ModuDevHook {
  openFile(path: string): Promise<void>;
  openFileInBackground(path: string): Promise<void>;
  closeAllTabs(): void;
  tabCount(): number;
  /** 重算壳层菜单显隐（顶栏拥挤态手工翻转后必须调，见 app/tabs.ts 的 syncMenus） */
  syncMenus(): void;
}

interface Window {
  __moduDev?: ModuDevHook;
}
