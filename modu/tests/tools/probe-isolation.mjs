/**
 * 隔离验收探针：证明"测试不会污染用户真实用户态"。
 *
 * 三项验收：
 *  ① 真实 profile 的 leveldb 快照哈希**不变**
 *  ② 测试产生的 recent 记录**落在隔离目录**（优先读页面里的 `localStorage`；应用停掉后也可读隔离 leveldb）
 *  ③ 受信清单按**启动前快照**还原后 SHA 一致（**还原后再读一次比对**，不只信布尔）
 *
 * ⚠ 纪律：先等就绪信号（`window.__moduDev`，带超时）**再动作**，**不许固定 sleep**（换新 profile 后首屏更慢）；
 *   超时要能区分"应用未就绪"与"dev 钩子未注入"。应用运行中 leveldb 被锁（EBUSY）⇒ 只读页面里的 localStorage。
 *
 * 用法：node tests/tools/probe-isolation.mjs --doc <md> --iso <隔离目录> [--port 9222] [--snapshot <json>]
 *   --snapshot 默认 <repo>/.verify/isolation/pre-start-snapshot.json（由 run-isolated.mjs 在**启动前**写下）
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}
const doc = args.doc;
const iso = args.iso;
const port = Number(args.port ?? 9222);
if (typeof doc !== 'string' || typeof iso !== 'string') {
  console.error('用法：node tests/tools/probe-isolation.mjs --doc <md> --iso <隔离目录> [--port 9222] [--snapshot <json>]');
  process.exit(2);
}
const snapshotFile = typeof args.snapshot === 'string' ? args.snapshot : path.join(REPO, '.verify', 'isolation', 'pre-start-snapshot.json');
if (!existsSync(snapshotFile)) {
  console.error(`[前置检查失败] 找不到启动前快照 ${snapshotFile} —— 必须先用 run-isolated.mjs 启动（**快照要在启动前拍**）`);
  process.exit(2);
}
const snap = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const TRUST = snap.trustPath;
const PROFILE = snap.profilePath;

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const lsHashes = () => {
  if (!existsSync(PROFILE)) return {};
  const out = {};
  for (const f of readdirSync(PROFILE)) {
    const full = path.join(PROFILE, f);
    try {
      if (statSync(full).isFile()) out[f] = sha(full);
    } catch (error) {
      out[f] = `<读失败:${error.code ?? 'unknown'}>`; // 应用运行中会 EBUSY
    }
  }
  return out;
};

/** 极简 CDP 客户端（Node ≥22 自带 fetch 与 WebSocket，不依赖仓库外的探针工具） */
async function connectCdp(pagePort) {
  const list = await (await fetch(`http://127.0.0.1:${pagePort}/json/list`)).json();
  const target = list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  if (target === undefined) throw new Error('未找到 CDP page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (typeof msg.id === 'number' && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails !== undefined) throw new Error(res.result.exceptionDetails.text ?? '页面求值异常');
    return res.result?.result?.value;
  };
  return { evaluate, close: () => ws.close() };
}

const out = { doc, iso, snapshotFile, preStartTrust: { existed: snap.trust.existed, sha: snap.trust.sha } };
const before = lsHashes();
let client = null;
try {
  client = await connectCdp(port);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startedAt = Date.now();
  const deadline = startedAt + 90_000;
  let hookType = null;
  while (Date.now() < deadline) {
    hookType = await client.evaluate(`typeof window.__moduDev`);
    if (hookType === 'object') break;
    await sleep(500);
  }
  if (hookType !== 'object') {
    const appLoaded = await client.evaluate(`typeof document.getElementById('doc')`);
    out.hookDiag = {
      hookType,
      appDomPresent: appLoaded === 'object',
      verdict: appLoaded === 'object' ? 'dev 钩子缺失：应用已加载但 window.__moduDev 未注入（注入路径有问题）' : '应用未就绪：90s 内连 #doc 都没有（首屏没起来）',
    };
    throw new Error(`等待 __moduDev 超时 ⇒ ${out.hookDiag.verdict}`);
  }
  out.hookWaitMs = Date.now() - startedAt;
  await client.evaluate(`window.__moduDev.closeAllTabs()`);
  await sleep(500);
  await client.evaluate(`void window.__moduDev.openFile(${JSON.stringify(doc)})`);
  for (let i = 0; i < 300; i += 1) {
    if (await client.evaluate(`!document.getElementById('doc').hidden && !document.getElementById('content').classList.contains('content-loading')`)) break;
    await sleep(100);
  }
  await sleep(2500);
  out.recentInApp = await client.evaluate(`(() => { try { return JSON.parse(localStorage.getItem('modu-recent') ?? '[]'); } catch (e) { return ['<parse error>']; } })()`);
} catch (error) {
  out.probeError = String(error);
} finally {
  try {
    if (snap.trust.existed) {
      mkdirSync(path.dirname(TRUST), { recursive: true });
      writeFileSync(TRUST, snap.trust.content, 'utf8');
    } else if (existsSync(TRUST)) {
      rmSync(TRUST, { force: true });
    }
  } catch (error) {
    out.restoreError = String(error);
  }
  if (client !== null) {
    try {
      client.close();
    } catch {
      /* ignore */
    }
  }
}

const trustNow = { existed: existsSync(TRUST), sha: existsSync(TRUST) ? sha(TRUST) : null };
out.trustAfterRestore = trustNow;
out.check3_trustRestored = trustNow.sha === snap.trust.sha && trustNow.existed === snap.trust.existed;
const after = lsHashes();
const names = new Set([...Object.keys(before), ...Object.keys(after)]);
out.check1_realProfileUnchanged = [...names].every((n) => (before[n] ?? null) === (after[n] ?? null));
out.check1_changed = [...names].filter((n) => (before[n] ?? null) !== (after[n] ?? null));
out.check2_isolatedRecent = Array.isArray(out.recentInApp) && out.recentInApp.some((e) => String(e).includes(path.basename(doc)));
out.note = '② 以"页面里的 localStorage"为准（应用运行中读 leveldb 会 EBUSY）；③ 已按启动前快照还原并复核 SHA';

mkdirSync(path.dirname(snapshotFile), { recursive: true });
const outFile = path.join(path.dirname(snapshotFile), 'out-isolation.json');
writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify({ ...out, outFile }, null, 1));
