/**
 * 启动包装：把 WebView2 的 user-data 目录钉到**隔离路径**，并保护"用户真实用户态"。
 *
 * 为什么需要它（2026-09-23 实测，见 modu/AGENTS.md「测试隔离」节）：
 *  - `app.windows[].dataDirectory` **不可靠**（实测什么都没建）⇒ 必须用 `WEBVIEW2_USER_DATA_FOLDER`；
 *  - 但 `localStorage` 之外的用户态（如 `%APPDATA%\<id>\trusted-paths.json`）**不在 WebView2 管辖内**
 *    ⇒ 只能靠本脚本"**启动前快照 + 任何退出路径还原**"。
 *
 * ⚠ 纪律（血泪）：
 *  - **快照必须在应用启动之前拍**；启动后拍 = 假还原（"前"已被本次启动污染，布尔却仍是 true）。
 *  - 原本**不存在**的受信清单 ⇒ 还原时**删掉**（不要写 `{}`，否则凭空造文件、下次快照对不上）。
 *  - 还原后**再读一次比 SHA**，不要只打印布尔。
 *
 * 用法（全部路径从参数/环境拿，换机器即用）：
 *   node tests/tools/run-isolated.mjs --iso <绝对隔离目录> --doc <md 路径> [选项]
 * 选项：
 *   --config <overlay 配置路径>   默认 <repo>/.verify/dev/tauri.dev-cdp.conf.json
 *   --app-dir <tauri 应用目录>    默认 <repo>/modu
 *   --snapshot <快照输出 json>    默认 <repo>/.verify/isolation/pre-start-snapshot.json
 *   --trust-rel <相对路径>        受信清单相对 %APPDATA%，默认 com.modu.reader/trusted-paths.json
 *   --profile-rel <相对路径>      leveldb 相对 %LOCALAPPDATA%，默认 com.modu.reader/EBWebView/Default/Local Storage/leveldb
 *   --no-spawn                    只做前置检查+快照（供调试）
 * 前置条件：能 `pnpm tauri dev`；隔离目录用绝对路径；`%APPDATA%`/`%LOCALAPPDATA%` 可取。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // <repo>
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) args[a.slice(2)] = process.argv[i + 1]?.startsWith('--') === false ? process.argv[++i] : true;
}

const isoDir = args.iso;
const doc = args.doc;
if (typeof isoDir !== 'string' || !path.isAbsolute(isoDir)) {
  console.error('[前置检查失败] 必须给 --iso <绝对隔离目录>（拒绝启动，否则会污染真实 profile）');
  process.exit(2);
}
if (typeof doc !== 'string' && args['allow-real-profile'] !== true) {
  console.error('[前置检查失败] 必须给 --doc <要打开的 md 路径>（受控例外 --allow-real-profile 下可省，表示"不打开任何文件"）');
  process.exit(2);
}
const config = typeof args.config === 'string' ? args.config : path.join(REPO, '.verify', 'dev', 'tauri.dev-cdp.conf.json');
const appDir = typeof args['app-dir'] === 'string' ? args['app-dir'] : path.join(REPO, 'modu');
const snapshotFile = typeof args.snapshot === 'string' ? args.snapshot : path.join(REPO, '.verify', 'isolation', 'pre-start-snapshot.json');
const trustRel = typeof args['trust-rel'] === 'string' ? args['trust-rel'] : path.join('com.modu.reader', 'trusted-paths.json');
const profileRel = typeof args['profile-rel'] === 'string' ? args['profile-rel'] : path.join('com.modu.reader', 'EBWebView', 'Default', 'Local Storage', 'leveldb');
const TRUST = path.join(process.env.APPDATA ?? os.homedir(), trustRel);
const PROFILE = path.join(process.env.LOCALAPPDATA ?? os.homedir(), profileRel);

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const lsHashes = () => {
  if (!existsSync(PROFILE)) return {};
  const out = {};
  for (const f of readdirSync(PROFILE)) {
    const full = path.join(PROFILE, f);
    if (statSync(full).isFile()) out[f] = sha(full);
  }
  return out;
};

console.log(`[前置检查] 隔离目录 = ${isoDir}`);
console.log(`[前置检查] 隔离目录启动前存在 = ${existsSync(isoDir)}`);
console.log(`[前置检查] 受信清单 = ${TRUST}`);
console.log(`[前置检查] 真实 profile leveldb = ${PROFILE}`);

/* 启动前快照（唯一基线） */
const trustSnapshot = {
  takenAt: new Date().toISOString(),
  dirExisted: existsSync(path.dirname(TRUST)),
  existed: existsSync(TRUST),
  content: existsSync(TRUST) ? readFileSync(TRUST, 'utf8') : null,
  sha: existsSync(TRUST) ? sha(TRUST) : null,
};
mkdirSync(path.dirname(snapshotFile), { recursive: true });
writeFileSync(
  snapshotFile,
  JSON.stringify({ isoDir, doc, trustPath: TRUST, profilePath: PROFILE, isoExistedBefore: existsSync(isoDir), trust: trustSnapshot, leveldb: lsHashes() }, null, 2),
  'utf8',
);
console.log(`[快照] 受信清单 存在=${trustSnapshot.existed} sha=${trustSnapshot.sha === null ? '(无)' : trustSnapshot.sha.slice(0, 16)} ⇒ ${snapshotFile}`);

/* 还原（任何退出路径） */
let restored = false;
function restoreTrust(reason) {
  if (restored) return;
  restored = true;
  try {
    if (trustSnapshot.existed) {
      mkdirSync(path.dirname(TRUST), { recursive: true });
      writeFileSync(TRUST, trustSnapshot.content, 'utf8');
    } else if (existsSync(TRUST)) {
      rmSync(TRUST, { force: true }); // 原本不存在 ⇒ 精确还原为"不存在"
    }
    const after = existsSync(TRUST) ? sha(TRUST) : null;
    console.log(`[还原(${reason})] 受信清单 存在=${existsSync(TRUST)} sha=${after === null ? '(无)' : after.slice(0, 16)} 与启动前一致=${after === trustSnapshot.sha}`);
  } catch (error) {
    console.error(`[还原失败(${reason})] ${String(error)} —— 请用快照 ${snapshotFile} 手工还原`);
  }
}
process.on('exit', () => restoreTrust('exit'));
process.on('SIGINT', () => {
  restoreTrust('SIGINT');
  process.exit(130);
});
process.on('SIGTERM', () => {
  restoreTrust('SIGTERM');
  process.exit(143);
});
// ⚠ SIGKILL 无法捕获 ⇒ 由验收探针（probe-isolation.mjs）以同一份快照兜底还原。

if (args['no-spawn'] === true) {
  restoreTrust('no-spawn');
  process.exit(0);
}

/* ⚠ 受控例外：`--allow-real-profile`（用于**清理真实 profile** 这类必须写真实用户态的操作）
   此时**不设** `WEBVIEW2_USER_DATA_FOLDER` ⇒ 应用用真实 profile。
   保护仍在：受信清单照样"启动前快照 + 退出还原"，且调用方必须保证**不打开任何文件**。 */
const allowReal = args['allow-real-profile'] === true;
if (allowReal) {
  console.log('[⚠ 受控例外] --allow-real-profile：本次**不用隔离 profile**（真实 profile 会被写）');
  console.log('           请确认：① 不打开任何文件 ② 这是有意的清理/维护操作');
}
const childEnv = { ...process.env };
if (allowReal) {
  delete childEnv.WEBVIEW2_USER_DATA_FOLDER;
} else {
  childEnv.WEBVIEW2_USER_DATA_FOLDER = isoDir;
}

const spawnArgs = ['tauri', 'dev', '--no-watch', '--config', config];
if (typeof doc === 'string') {
  spawnArgs.push('--', doc); // 没给 doc（受控例外）⇒ 不传文件参数 ⇒ 应用不打开任何文件
}
const child = spawn('pnpm', spawnArgs, {
  cwd: appDir,
  stdio: 'inherit',
  shell: true,
  env: childEnv,
});
child.on('exit', (code) => {
  console.log(`[应用退出] code=${code}`);
  restoreTrust('child-exit');
  process.exit(0);
});
