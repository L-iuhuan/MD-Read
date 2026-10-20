/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 设置面板脚注的版本号唯一来源：package.json（禁在 UI/配置里手抄第二份）。
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    // ⚠ 门禁稳定性（2026-10-20 实测两次假红）：本机全量套件并行时 jsdom 环境创建占总时长 70%+，
    //   而部分回归锚要 execFileSync/spawnSync 冷启动 node 子进程（extract-leveldb / scan-markers 等）
    //   ⇒ 默认 5000ms 在机器负载高时偶发超时假红（直接导致 commit 门禁拒绝提交，与改动无关）。
    //   这里只放宽**默认超时**，断言语义不变；个别更重的用例仍显式写 90s（live-preview / scan-markers）。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
}));
