#!/usr/bin/env node
// 把 index.html 逐帧渲染成 PNG（不依赖任何 npm 包：直接用 Chrome DevTools 协议）。
//   node render.mjs --out <帧目录>              全片逐帧导出（1920×1080，30fps）
//   node render.mjs --shots --out <目录>        只导出脚本里标记的关键画面（调试用）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = n => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const SHOTS = flag('shots');
const FPS = Number(opt('fps', 30));
const SCALE = Number(opt('scale', 4 / 3));          // 1440×810 × 4/3 = 1920×1080
const OUT = path.resolve(opt('out', path.join(here, 'out', SHOTS ? 'shots' : 'frames')));
const FROM = Number(opt('from', 0)), UNTIL = Number(opt('until', Infinity));   // 只导出某一段（秒），调试用
const FW = 1440, FH = 810;

const CHROME = [
  process.env.CHROME_BIN,
  `${os.homedir()}/Library/Caches/ms-playwright/chromium-1140/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find(p => p && fs.existsSync(p));
if (!CHROME) { console.error('找不到 Chrome/Chromium，可用环境变量 CHROME_BIN 指定'); process.exit(1); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const profile = path.join(OUT, '.chrome-profile');

const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--allow-file-access-from-files',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${FW},${FH}`, 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
const quit = code => { try { proc.kill(); } catch {} setTimeout(() => { fs.rmSync(profile, { recursive: true, force: true }); process.exit(code); }, 300); };

const port = await new Promise((res, rej) => {
  let buf = '';
  proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//); if (m) res(m[1]); });
  proc.on('exit', c => rej(new Error('浏览器提前退出 ' + c + '\n' + buf)));
  setTimeout(() => rej(new Error('浏览器启动超时\n' + buf)), 20000);
});
let target;
for (let i = 0; i < 50 && !target; i++) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
  target = list.find(t => t.type === 'page');
  if (!target) await new Promise(r => setTimeout(r, 100));
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map(); const waiters = new Map();
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
  else if (waiters.has(m.method)) { waiters.get(m.method)(m.params); waiters.delete(m.method); }
};
const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++seq, { res, rej }); ws.send(JSON.stringify({ id: seq, method, params })); });
const once = method => new Promise(res => waiters.set(method, res));
const evalJS = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: FW, height: FH, deviceScaleFactor: SCALE, mobile: false });
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: pathToFileURL(path.join(here, 'index.html')).href + '?render=1' });
await loaded;
await evalJS('document.fonts.ready.then(() => true)');
// 预热：切换渲染倍率后的头一两张截图可能还是旧尺寸，先空截丢弃
for (let i = 0; i < 3; i++) await send('Page.captureScreenshot', { format: 'png' });

const t0 = Date.now(); let frames = 0, shots = 0;
for (let i = 1; ; i++) {
  const dt = i * 1000 / FPS - (i - 1) * 1000 / FPS;
  const st = JSON.parse(await evalJS(`__advance(${dt}).then(() => JSON.stringify({ done: !!window.__done, err: window.__error || null, shot: window.__shot, dbg: window.__dbg, now: __now() }))`));
  if (st.err) { console.error('页面脚本出错：\n' + st.err); quit(1); break; }
  if (SHOTS) {
    if (st.shot) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${st.shot}.png`), Buffer.from(data, 'base64'));
      console.log(`shot ${st.shot} @ ${(st.now / 1000).toFixed(1)}s  flow=${JSON.stringify(st.dbg)}`); shots++;
      await evalJS('window.__shot = null');
    }
  } else if (st.now / 1000 >= FROM) {
    const { data } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    fs.writeFileSync(path.join(OUT, `f_${String(i).padStart(5, '0')}.png`), Buffer.from(data, 'base64'));
    frames++;
    if (i % 150 === 0) console.log(`${(st.now / 1000).toFixed(0)}s 已渲染 · ${frames} 帧 · 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (st.done || st.now / 1000 >= UNTIL) { console.log(`完成：片长 ${(st.now / 1000).toFixed(1)}s，${SHOTS ? shots + ' 张关键画面' : frames + ' 帧'} → ${OUT}`); quit(0); break; }
}
