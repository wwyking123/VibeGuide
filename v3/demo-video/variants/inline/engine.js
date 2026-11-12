// VibeGuide 示意视频 —— 动画引擎
// 所有时间都走"虚拟时钟"：实时预览时由 requestAnimationFrame 推进；
// 导出视频时由 render.mjs 每帧推进 1/30 秒再截图，所以导出画面不受机器快慢影响。

const FW = 1440, FH = 810;       // 画面（导出时 ×4/3 = 1920×1080）
const RENDER = new URLSearchParams(location.search).has('render');

/* ───────── 虚拟时钟 ───────── */
const VT = (() => {
  let now = 0;
  const timers = [];
  const starts = new WeakMap();
  const hop = () => new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  function sleep(ms) { return new Promise(res => timers.push({ due: now + Math.max(0, ms), res })); }
  function sync() {                 // 把所有 CSS 动画/过渡也挂到虚拟时钟上
    for (const a of document.getAnimations()) {
      let s = starts.get(a);
      if (s === undefined) { try { a.pause(); } catch {} s = now; starts.set(a, s); }
      const t = now - s;
      const end = a.effect ? a.effect.getComputedTiming().endTime : Infinity;
      try { if (t >= end) a.finish(); else a.currentTime = t; } catch {}
    }
  }
  let busy = false;
  async function advance(dt) {
    if (busy) return; busy = true;
    const target = now + dt;
    for (;;) {
      let idx = -1, best = Infinity;
      for (let i = 0; i < timers.length; i++) if (timers[i].due <= target && timers[i].due < best) { best = timers[i].due; idx = i; }
      if (idx < 0) break;
      const t = timers.splice(idx, 1)[0];
      now = Math.max(now, t.due);
      t.res();
      await hop();
    }
    now = target;
    sync();
    busy = false;
  }
  return { sleep, advance, get now() { return now; } };
})();
const sleep = VT.sleep;
window.__advance = dt => VT.advance(dt);
window.__now = () => VT.now;

/* ───────── 小工具 ───────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
let seed = 20261112;
function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

const P = {
  plus: 'M8 3v10M3 8h10',
  edit: 'M9 3H4.5A1.5 1.5 0 003 4.5v7A1.5 1.5 0 004.5 13h7a1.5 1.5 0 001.5-1.5V7M11.9 2.6l1.5 1.5-4.8 4.8-1.9.4.4-1.9z',
  panelL: 'M4.5 3h7A2 2 0 0113.5 5v6a2 2 0 01-2 2h-7a2 2 0 01-2-2V5a2 2 0 012-2zM6.5 3v10',
  panelR: 'M4.5 3h7A2 2 0 0113.5 5v6a2 2 0 01-2 2h-7a2 2 0 01-2-2V5a2 2 0 012-2zM9.5 3v10',
  folder: 'M2.5 5A1.5 1.5 0 014 3.5h2.2l1.4 1.5H12A1.5 1.5 0 0113.5 6.5V11A1.5 1.5 0 0112 12.5H4A1.5 1.5 0 012.5 11z',
  chev: 'M4.5 6.5L8 10l3.5-3.5',
  up: 'M8 12.5v-9M4.2 7.2L8 3.5l3.8 3.7',
  copy: 'M7 5.5h5A1.5 1.5 0 0113.5 7v5a1.5 1.5 0 01-1.5 1.5H7A1.5 1.5 0 015.5 12V7A1.5 1.5 0 017 5.5zM10.5 5.5V4A1.5 1.5 0 009 2.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5',
  redo: 'M12.5 8a4.5 4.5 0 11-1.4-3.3M12.6 2.6v2.6H10',
  file: 'M4.5 2.5h4.2l2.8 2.8v7.2a1 1 0 01-1 1h-6a1 1 0 01-1-1v-9a1 1 0 011-1zM8.6 2.7v2.9h2.8',
  term: 'M3.5 5l3 3-3 3M8.2 11.5h4.3',
  check: 'M3.5 8.4l3 3 6-6.6',
  spark: 'M8 2.5l1.3 3.2 3.2 1.3-3.2 1.3L8 11.5 6.7 8.3 3.5 7l3.2-1.3zM12.5 11v2.5M11.2 12.3h2.6',
  clip: 'M11.8 7.2L7.6 11.4a2.3 2.3 0 01-3.3-3.3l4.6-4.6a1.6 1.6 0 012.3 2.3L6.7 10.3a.8.8 0 01-1.2-1.2l3.9-3.9',
  thumb: 'M5.5 7.2l2.3-4.2c.9 0 1.6.7 1.6 1.6v1.9h2.7a1.2 1.2 0 011.2 1.4l-.6 3.6a1.2 1.2 0 01-1.2 1H5.5zM5.5 7.2H3v5.3h2.5',
  down: 'M8 3v7.2M5 7.5l3 3 3-3',
};
function ic(name, size = 16, sw = 1.4) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="${P[name]}"/></svg>`;
}
// VibeGuide 的标记：一颗四角星
const VGM = '<svg class="vgm" viewBox="0 0 16 16"><path fill="currentColor" d="M8 1.2c.6 3.7 3.1 6.2 6.8 6.8-3.7.6-6.2 3.1-6.8 6.8-.6-3.7-3.1-6.2-6.8-6.8 3.7-.6 6.2-3.1 6.8-6.8z"/></svg>';

/* ───────── 坐标 ───────── */
function frect(node) {            // 元素在 1440×810 画面坐标系里的矩形
  const f = $('#frame').getBoundingClientRect(), k = f.width / FW, r = node.getBoundingClientRect();
  return { x: (r.left - f.left) / k, y: (r.top - f.top) / k, w: r.width / k, h: r.height / k };
}
function rel(node, box) { const a = frect(node), b = frect(box); return { x: a.x - b.x, y: a.y - b.y, w: a.w, h: a.h }; }

/* ───────── 光标 ───────── */
let cpos = { x: 1010, y: 560 };
async function moveTo(target, { dx = 0, dy = 0, ax = .5, ay = .5, ms } = {}) {
  let x, y;
  if (target instanceof Element) { const r = frect(target); x = r.x + r.w * ax + dx; y = r.y + r.h * ay + dy; }
  else ({ x, y } = target);
  const dist = Math.hypot(x - cpos.x, y - cpos.y);
  ms ??= Math.round(Math.max(240, Math.min(720, 190 + dist * .85)));
  const c = $('#cursor');
  c.style.transitionDuration = ms + 'ms';
  c.style.transform = `translate(${x}px, ${y}px)`;
  cpos = { x, y };
  await sleep(ms + 40);
}
function ripple() {
  const r = el('<div class="ripple"></div>'); r.style.left = cpos.x + 'px'; r.style.top = cpos.y + 'px';
  $('#overlay').append(r); sleep(480).then(() => r.remove());
}
async function click(target, opts = {}) {
  await moveTo(target, opts);
  const c = $('#cursor'); c.classList.add('down'); ripple();
  if (target instanceof Element) target.classList.add('pressed');
  await sleep(120);
  c.classList.remove('down');
  if (target instanceof Element) target.classList.remove('pressed');
  await sleep(opts.after ?? 130);
}

/* ───────── 打字 / 流式输出 ───────── */
async function type(node, text, { cps = 11 } = {}) {
  let tx = $('.tx', node);
  if (!tx) { node.innerHTML = '<span class="tx"></span><span class="caret"></span>'; tx = $('.tx', node); }
  for (const ch of text) {
    tx.append(ch);
    await sleep(1000 / cps * (.55 + rnd() * .9) * (/[，。？！、]/.test(ch) ? 2.2 : 1));
  }
}
async function stream(node, html, { cps = 70, chunk = 2 } = {}) {
  node.innerHTML = html;
  const toks = [];
  const walk = n => {
    for (const c of [...n.childNodes]) {
      if (c.nodeType === 3) {
        const s = c.nodeValue;
        if (!s.trim()) continue;
        const frag = document.createDocumentFragment();
        for (let i = 0; i < s.length; i += chunk) { const sp = document.createElement('span'); sp.className = 'tk'; sp.textContent = s.slice(i, i + chunk); frag.append(sp); toks.push(sp); }
        c.replaceWith(frag);
      } else if (c.nodeType === 1) {
        c.classList.add('pend');
        if (!c.textContent.trim()) toks.push(c); else walk(c);
      }
    }
  };
  walk(node);
  for (const tk of toks) {
    for (let p = tk; p && p !== node; p = p.parentElement) p.classList.remove('pend');
    if (tk.classList.contains('tk')) tk.classList.add('on');
    await sleep(1000 * chunk / cps);
  }
}

/* ───────── 高亮圈 ───────── */
function ring(node, ms = 1500, pad = 5, radius) {
  const r = frect(node), d = el('<div class="ring"></div>');
  Object.assign(d.style, { left: r.x - pad + 'px', top: r.y - pad + 'px', width: r.w + pad * 2 + 'px', height: r.h + pad * 2 + 'px' });
  if (radius != null) d.style.borderRadius = radius + 'px';
  $('#overlay').append(d);
  const off = async () => { d.classList.add('out'); await sleep(260); d.remove(); };
  if (ms) sleep(ms).then(off);
  return off;
}

/* ───────── 关键画面截图请求（仅调试用，不占时间线） ───────── */
window.__shot = null;
function shot(name, delay = 480) { if (RENDER) sleep(delay).then(() => { window.__shot = name; }); }

/* ───────── 启动 ───────── */
function fit() {
  if (RENDER) return;
  const k = Math.min(innerWidth / FW, innerHeight / FH);
  $('#frame').style.transform = `translate(${(innerWidth - FW * k) / 2}px, ${(innerHeight - FH * k) / 2}px) scale(${k})`;
}
function boot(main) {
  fit(); addEventListener('resize', fit);
  window.__done = false;
  main().then(() => { window.__done = true; }, e => { console.error(e); window.__error = String(e && e.stack || e); window.__done = true; });
  if (!RENDER) {
    let last;
    const loop = ts => { if (last === undefined) last = ts; const dt = Math.min(80, ts - last); last = ts; VT.advance(dt).then(() => requestAnimationFrame(loop)); };
    requestAnimationFrame(loop);
  }
}
