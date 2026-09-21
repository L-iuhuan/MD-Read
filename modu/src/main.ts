import { invoke } from "@tauri-apps/api/core";

function appendLog(line: string): void {
  const el = document.getElementById("spike-log");
  if (el) {
    el.textContent += line + "\n";
  }
}

async function log(msg: string): Promise<void> {
  const line = `[spike] ${msg}`;
  appendLog(line);
  try {
    await invoke("spike_log", { msg });
  } catch (e) {
    appendLog(`[spike] spike_log 上报失败: ${String(e)}`);
  }
}

async function spike2PrintToPdf(): Promise<void> {
  try {
    const result = await invoke<string>("spike_print_pdf");
    await log(`spike-2 PrintToPdf ✓ ${result}`);
  } catch (e) {
    await log(`spike-2 PrintToPdf ✗ ${String(e)}`);
  }
}

export async function spike1WindowPrint(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let before = false;
  let after = false;
  window.addEventListener("beforeprint", () => {
    before = true;
  });
  window.addEventListener("afterprint", () => {
    after = true;
  });
  const t0 = Date.now();
  let blockedMs = -1;
  try {
    window.print();
    blockedMs = Date.now() - t0;
  } catch (e) {
    await log(`spike-1 window.print() 抛异常: ${String(e)}`);
  }
  await log(
    `spike-1 window.print(): 阻塞 ${blockedMs}ms，beforeprint=${before}，afterprint=${after}`,
  );
}

async function runSpikes(): Promise<void> {
  await log("spike harness 启动");
  await spike2PrintToPdf();
  // spike-1 结论已留档 M0 任务书（window.print 会弹 UI 并阻塞），不再自动跑以免干扰
  await log("SPIKE-DONE");
}

window.addEventListener("DOMContentLoaded", () => {
  runSpikes();
});
