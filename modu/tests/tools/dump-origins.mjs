/**
 * origin 账：把 `localStorage` 的"按 origin 分域"事实量出来。
 *
 * 背景（2026-09-23）：仓库里 `modu-recent` 的抽取器是**直接扫 leveldb 原始字节**（跨 origin 都能看到），
 * 而页面里的 `localStorage` **只属于当前 origin** ⇒ 两者读数可能来自**不同的存储域**。
 * 本工具两个模式各出一半证据：
 *   --page            连 CDP 读页面侧：`location.origin` + `Object.keys(localStorage)` + 各键**原始值**
 *                     （`null` = 键不存在，`'[]'` = 存在但空 —— **必须区分**）
 *   --leveldb <dir>   只读扫 leveldb：列出**每个 origin** 的 `modu-recent` 条数与内容
 *                     （应用运行中 leveldb 被锁 ⇒ 先停应用再跑本模式）
 *
 * 用法：
 *   node tests/tools/dump-origins.mjs --page [--port 9222] [--key modu-recent]
 *   node tests/tools/dump-origins.mjs --leveldb <leveldb 目录> [--key modu-recent] [--test-prefix <路径前缀>]
 *   （不给 --leveldb 时用 %LOCALAPPDATA% 下默认路径；README/AGENTS 里有说明）
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}
const key = typeof args.key === 'string' ? args.key : 'modu-recent';
const testPrefix = typeof args['test-prefix'] === 'string' ? args['test-prefix'] : REPO;

/* ---------- 页面侧 ---------- */
async function pageMode() {
  const port = Number(args.port ?? 9222);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, (msg) => resolve(msg.result?.result?.value));
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  // 先等就绪信号（不许固定 sleep）
  const deadline = Date.now() + 90_000;
  let hook = null;
  while (Date.now() < deadline) {
    hook = await evaluate(`typeof window.__moduDev`);
    if (hook === 'object') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const K = JSON.stringify(key);
  const raw = await evaluate(
    `(() => {
      const keys = Object.keys(localStorage);
      const out = { origin: location.origin, href: location.href, keys: {} };
      for (const k of keys) out.keys[k] = localStorage.getItem(k);
      const v = localStorage.getItem(${K});
      out.keyRaw = v;                       // 原始字符串：null 与 '[]' 可区分
      out.keyIsNull = v === null;           // true = 键不存在
      return out;
    })()`,
  );
  ws.close();
  return { mode: 'page', hookType: hook, ...raw };
}

/* ---------- leveldb 侧 ---------- */
function leveldbMode() {
  const dir = typeof args.leveldb === 'string' ? args.leveldb : path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'com.modu.reader', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
  if (!existsSync(dir)) return { mode: 'leveldb', error: `目录不存在: ${dir}` };
  const MARKER = Buffer.from(`\u0000\u0001${key}`, 'utf8');
  const ORIGIN_RE = /(https?:\/\/[^\u0000\s"']{1,80}|tauri:\/\/[^\u0000\s"']{1,80}|asset:\/\/[^\u0000\s"']{1,80}|file:\/\/[^\u0000\s"']{1,80})/;
  const perOrigin = new Map();
  const files = [];
  for (const f of readdirSync(dir).filter((x) => !statSync(path.join(dir, x)).isDirectory())) {
    const mt = statSync(path.join(dir, f)).mtimeMs;
    const buf = readFileSync(path.join(dir, f));
    files.push({ file: f, bytes: buf.length, mtime: new Date(mt).toISOString() });
    let at = buf.indexOf(MARKER);
    while (at !== -1) {
      // 往前找 origin（`_<origin>` 前缀）
      const back = buf.subarray(Math.max(0, at - 120), at).toString('utf8');
      const m = ORIGIN_RE.exec(back);
      const origin = m === null ? '(未识别)' : m[1];
      // 值：marker 之后按 UTF-16LE 两种偏移试解析 JSON 数组
      const region = buf.subarray(at + MARKER.length, Math.min(buf.length, at + MARKER.length + 12000));
      let entries = null;
      let enc = null;
      for (const parity of [0, 1]) {
        const text = region.subarray(parity).toString('utf16le');
        const start = text.indexOf('[');
        if (start === -1) continue;
        let depth = 0;
        for (let i = start; i < Math.min(text.length, start + 20000); i += 1) {
          depth += text[i] === '[' ? 1 : text[i] === ']' ? -1 : 0;
          if (depth === 0) {
            try {
              const parsed = JSON.parse(text.slice(start, i + 1).replace(/\u0000/g, ''));
              if (Array.isArray(parsed)) {
                entries = parsed.map(String);
                enc = `utf16le(parity=${parity})`;
              }
            } catch {
              /* 继续 */
            }
            break;
          }
        }
        if (entries !== null) break;
      }
      const prev = perOrigin.get(origin) ?? { origin, hits: [], file: f };
      prev.hits.push({ file: f, offset: at, mtime: mt, encoding: enc, count: entries === null ? null : entries.length, entries });
      perOrigin.set(origin, prev);
      at = buf.indexOf(MARKER, at + MARKER.length);
    }
  }
  const origins = [...perOrigin.values()].map((o) => {
    // 取"条数最多"的那次命中作为该 origin 的 live 值
    // ⚠ 不能按"条数最多"选（leveldb 保留历史版本 ⇒ 会挑中陈旧值、造出假警报）；
    //    规则：按 (文件 mtime desc, 块内偏移 desc) 排序，取**第一个能解析**的命中（= 最新活动文件里的最后一次写）
    const best =
      o.hits
        .slice()
        .sort((a, b) => b.mtime - a.mtime || b.offset - a.offset)
        .find((h) => h.count !== null) ?? o.hits[o.hits.length - 1];
    const entries = best?.entries ?? [];
    return {
      origin: o.origin,
      liveCount: best?.count ?? null,
      encoding: best?.encoding ?? null,
      testEntries: entries.filter((e) => e.startsWith(testPrefix)),
      otherEntries: entries.filter((e) => !e.startsWith(testPrefix)),
      hits: o.hits.length,
      files: [...new Set(o.hits.map((h) => h.file))],
    };
  });
  return { mode: 'leveldb', dir, files, origins };
}

const result = args.page === true ? await pageMode() : leveldbMode();
console.log(JSON.stringify(result, null, 1));
