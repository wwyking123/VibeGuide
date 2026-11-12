// VibeGuide 演示视频（0.2 版）—— 演示脚本
// 结构：完整的 Harness 窗口 + 右侧 VibeGuide 侧栏，四段依次演示
//   01 先问清楚 → 02 做到哪了 → 03 说人话 → 04 一张图看懂 → 05 看不懂就问
// 例子：做个网页，让小组每周交工作总结。
// 侧栏的结构和类名与 src/client 里的真实组件一致，样式来自 sidebar.css；只演示 0.2 现在真实有的功能。
// 动画引擎、导出脚本和宿主窗口的画法来自 v3 示意片。

const PLACEHOLDER = '发消息或创建任务, / 调用指令, @ 文件或对话';
const ASK_PH = '想弄明白什么？要修改请在主对话说';
const IDEA = '想做个网页，让我们组 8 个人每周交工作总结，我一页看完';
const TITLE = '每周总结网页';
const QUESTION = '组员在自己电脑上能交吗？';
const SUGGESTION = '把总结存到全组都能访问的地方，让组员打开链接就能提交，我在汇总页看到所有人的。';
const HANDOFF = `请把大家提交的总结改成存到全组都能访问的地方：组员打开链接就能提交，我在汇总页能看到所有人的。

之前的约定不变：总结只有我能看。`;

// 开工前主 AI 问的两个问题：问的是你答得上来的事，每个选项写清选了会怎样
const QS = [
  { t: '交上来的总结，谁能看？', short: ['谁能看', '只有你'], opts: [['只有你能看', '最简单，不用区分每个人的身份', 1], ['全组互相可见', '每个人都能看到所有人的总结'], ['每人只看自己的', '要先做登录，才能认出谁是谁']] },
  { t: '先在哪里用？', short: ['先在哪用', '你的电脑上'], opts: [['先在你的电脑上试', '今天就能看到效果', 1], ['直接发给全组用', '要先放到网上，步骤更多']] },
];

// 同一轮工作，标准模式下常见的回答：事实都对，但要先懂技术才读得下去
const TECH = `<p>已完成初版实现。技术栈为 Vite 5 + React 18（函数组件 + Hooks），未引入路由库，在 <code>App.jsx</code> 中通过 <code>useState</code> 切换 <code>FillForm</code> / <code>Summary</code> 两个视图。</p>
<p><b>实现细节</b></p>
<ul><li><code>src/storage.js</code>：封装 <code>localStorage</code> 读写，key 为 <code>weekly-notes:v1</code>，值为 <code>Array&lt;{ name, week, text, ts }&gt;</code> 的 JSON 序列化结果，<code>week</code> 取 ISO 8601 周编号</li>
<li><code>src/FillForm.jsx</code>：受控表单，<code>onSubmit</code> 做非空校验后调用 <code>saveEntry()</code>，随后重置 state</li>
<li><code>src/Summary.jsx</code>：用 <code>useMemo</code> 按 <code>name</code> 做 groupBy，按 <code>ts</code> 倒序渲染</li>
<li><code>WeekSwitcher</code> 组件已挂载，<code>onChange</code> 回调暂为 no-op（TODO）</li></ul>
<p><b>构建与验证</b></p>
<ul><li><code>npm run build</code> 通过，产物 142.3 kB（gzip 46.1 kB），无 ESLint error</li>
<li>dev server：<code>npm run dev</code>，默认监听 <code>http://localhost:5173</code></li></ul>
<p><b>已知限制</b></p>
<ul><li>持久化为浏览器本地存储，无服务端；跨设备 / 多用户同步需引入后端（如 Supabase 或自建 REST API）并迁移 storage 层</li>
<li>未做鉴权，未限制输入长度，未处理并发写入</li></ul>
<p><b>后续建议</b></p>
<ul><li>抽离 <code>useEntries()</code> 自定义 Hook，统一 storage 订阅与 state 同步</li>
<li>接入后端时将 <code>storage.js</code> 替换为异步 adapter，接口签名保持 <code>Promise&lt;Entry[]&gt;</code></li>
<li>为 <code>FillForm</code> 补充单元测试（Vitest + Testing Library），当前覆盖率为 0</li></ul>`;
const reply = id => `<div class="blk" id="${id}-what"><p>第一版做好了，现在就能试：打开 <a>http://localhost:5173</a></p>
    <ul><li><b>填写页</b>：填名字和本周总结，点提交</li><li><b>汇总页</b>：按人排好，一页看完</li></ul></div>
    <p class="blk" id="${id}-term">提交的内容用 <span class="sel" id="${id === 'm' ? 'term' : 'c-sel'}">localStorage</span> 保存，也就是存在这台电脑的浏览器里：刷新不会丢，换一台电脑就看不到。</p>
    <div class="blk" id="${id}-honest"><p>有两点要如实告诉你：</p>
    <ul><li>「按周切换」的按钮<b>还只是样子</b>，点了不会换周</li><li>按你选的先在这台电脑上试，所以<b>组员现在还交不了</b></li></ul></div>`;

const BOOK = (size = 15, sw = 1.6) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none"><path d="M4 5c3-1 5-1 8 1 3-2 5-2 8-1v14c-3-1-5-1-8 1-3-2-5-2-8-1V5Zm8 1v14" stroke="currentColor" stroke-width="${sw}" stroke-linejoin="round"/></svg>`;
const REFRESH = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const GEAR = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// 项目结构：从用户看到的，到数据存在哪里
const LAYERS = [
  { label: '用户看到的', parts: [
    { id: 'fill', title: '填写页', purpose: '填名字和本周总结，点提交。', tag: 'ok' },
    { id: 'sum', title: '汇总页', purpose: '按人排好，一页看完全组的总结。', tag: 'ok' },
    { id: 'week', title: '按周切换', purpose: '翻看往周的总结。', tag: 'warn' },
  ] },
  { label: '背后的规则', link: '用到', parts: [
    { id: 'rule', title: '提交与整理', purpose: '检查有没有填名字，把总结按人归好。', tag: 'ok' },
  ] },
  { label: '数据存在哪里', link: '保存在', parts: [
    { id: 'local', title: '本机保存', purpose: '把提交的总结存在这台电脑的浏览器里。', tag: 'ok' },
    { id: 'shared', title: '全组共用的保存', purpose: '让 8 个人各自提交后，你都能看到。', tag: 'missing' },
  ] },
];
const TAGS = { ok: '<span class="vg-tag vg-tag-ok">● 能用</span>', warn: '<span class="vg-tag vg-tag-warn">◐ 模拟</span>', missing: '<span class="vg-tag">○ 还没做</span>' };

/* ───────── 界面骨架 ───────── */
function buildShell() {
  $('#app').innerHTML = `
  <aside class="lsb">
    <div class="top"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div><span class="ib">${ic('panelL')}</span></div>
    <div class="brand"><img src="assets/dsh-logo.png" alt=""><b>DSH</b></div>
    <div class="newsess">${ic('edit', 15)}新会话</div>
    <div class="sgroup">今天</div>
    <div class="srow active" id="srow"><span id="srow-t">新会话</span><i class="run"></i></div>
    <div class="srow"><span>活动报名表单</span></div>
    <div class="sgroup">近 7 天</div>
    <div class="srow"><span>整理客户访谈纪要</span></div>
    <div class="srow"><span>Excel 转查询页面</span></div>
    <div class="srow"><span>个人主页改版</span></div>
    <div class="foot"><span class="avatar">我</span><span style="flex:1">设置</span>${ic('sliders', 15)}</div>
  </aside>
  <main class="center" id="center">
    <header class="chead"><div><span id="stitle">新会话</span><span class="mode" id="hmode"></span></div><span class="ib">${ic('panelR')}</span></header>
    <div id="flow"><div class="empty" id="hero-mark"><img src="assets/dsh-logo.png" alt=""></div></div>
    <div class="composer"><div class="ccard" id="ccard">
      <div class="ctext" id="ctext"><span class="ph">${PLACEHOLDER}</span></div>
      <div class="cbar"><span class="ib">${ic('clip')}</span><span class="chip">${ic('folder')}weekly-notes</span><span class="chip" id="modechip">标准模式${ic('chev', 13)}</span><span class="chip">DeepSeek${ic('chev', 13)}</span><span class="send off" id="send">${ic('up', 16, 1.9)}</span></div>
    </div></div>
  </main>
  <aside class="rsb" id="rsb">
    <div class="rtabs">
      <div class="rtab on" id="rtab-vg">${BOOK(15)}VibeGuide</div>
      <div class="rtab">${ic('file', 15)}文件</div><div class="rtab">${ic('term', 15)}终端</div>
      <span class="sp"></span><span class="ib">${ic('plus', 15)}</span><span class="ib">${ic('full', 14)}</span>
    </div>
    <section class="vg-panel" id="vg">
      <div class="vg-content" id="vgc">
        <div class="vg-top"><strong id="vg-name">weekly-notes</strong><div class="vg-tools"><button class="vg-icon">${REFRESH}</button><button class="vg-icon" id="vg-gear" hidden>${GEAR}</button></div></div>
        <div id="vg-gate"><p class="vg-notice" style="margin-top:12px">请在主对话选择 VibeGuide 模式后使用侧栏。</p></div>
        <div id="vg-main" hidden>
          <nav class="vg-tabs"><button aria-pressed="true" data-t="progress">进展</button><button aria-pressed="false" data-t="structure">项目结构</button></nav>
          <div id="pane-progress">
            <div class="vg-status"><div class="vg-status-line"><span class="vg-dot" id="st-dot"></span><h3 id="st-h">AI 已停下</h3></div><p class="vg-sub" id="st-sub" hidden></p></div>
            <p class="vg-sub" id="st-first">先在主对话说说你想做什么，之后可以在这里问它的影响。</p>
            <div id="choices"></div>
            <div id="receipts"></div>
            <div class="vg-intro" id="intro" hidden>
              <p>在这里问看不懂的地方，比如 AI 给的方案、选项或报错。要修改请直接在主对话说。</p>
              <p class="vg-sub">“项目结构”里能看到项目分成哪几部分，各做到什么程度。</p>
              <div class="vg-actions"><button>这个项目现在能做什么？</button><button>下一步做什么比较好？</button></div>
            </div>
            <div id="answers"></div>
            <section id="reqs" hidden><div class="vg-label">你的要求</div><div class="vg-list" id="req-list"></div></section>
          </div>
          <div id="pane-structure" hidden></div>
        </div>
      </div>
      <footer class="vg-composer" id="vg-foot" hidden><form>
        <div id="quote-slot"></div>
        <div class="vg-input"><div class="vg-ta" id="vg-ta"><span class="ph">${ASK_PH}</span></div><button type="button" class="vg-primary" id="vg-send" disabled>发送</button></div>
        <div id="vg-busy"></div>
      </form></footer>
    </section>
  </aside>`;
}

/* ───────── 主对话的小函数 ───────── */
const flow = () => $('#flow');
function setRunning(on) {
  $('#srow').classList.toggle('running', on);
  const s = $('#send');
  s.classList.toggle('off', !on);
  s.innerHTML = on ? '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="#fff"/></svg>' : ic('up', 16, 1.9);
}
function setComposer(text) {
  const c = $('#ctext');
  if (!text) { c.innerHTML = `<span class="ph">${PLACEHOLDER}</span>`; $('#send').classList.add('off'); return; }
  c.textContent = text; $('#send').classList.remove('off');
}
function addUser(text) {
  $('#hero-mark')?.remove();
  const r = el('<div class="urow"><div class="bubble"><div class="bt"></div></div></div>');
  $('.bt', r).textContent = text; flow().append(r); pin(flow()); return r;
}
function addTurn() { const t = el('<div class="aturn"></div>'); flow().append(t); pin(flow()); return t; }
function addStep(turn, icon, verb, arg, running) {
  const s = el(`<div class="step">${ic(icon, 15)}<span>${verb}</span>${arg ? `<code>${arg}</code>` : ''}${running ? '<i class="spin"></i>' : ''}</div>`);
  turn.append(s); pin(flow()); return s;
}
async function runStep(turn, icon, ing, done, arg, ms) {
  const s = addStep(turn, icon, ing, arg, true);
  await sleep(ms);
  $('span', s).textContent = done; $('.spin', s).remove();
  return s;
}

function showQuestion(turn, i) {
  const q = QS[i];
  $('#qcard')?.remove();
  const card = el(`<div class="qcard" id="qcard"><div class="qh"><span>需要你确认</span><span>${i + 1} / ${QS.length}</span></div><div class="qt">${q.t}</div>
    ${q.opts.map(o => `<div class="qopt"><i class="rad"></i><div><b>${o[0]}</b>${o[2] ? '<em>推荐</em>' : ''}<p>${o[1]}</p></div></div>`).join('')}
    <div class="qf">其他，我来说…</div></div>`);
  turn.append(card); pin(flow());
  // 侧栏同步出现这道题（结构同真实组件）
  $('#choices').innerHTML = `<article class="vg-card vg-choice"><small>主对话正在等你选择</small><h3>${q.t}</h3>
    <ul>${q.opts.map(o => `<li><strong>${o[0]}</strong><span>：${o[1]}</span></li>`).join('')}</ul>
    <button type="button" id="help-choice">帮我看懂这些选项</button><p class="vg-muted">选好后，请回左侧主对话的原问题作答。</p></article>`;
  return card;
}

/* ───────── 侧栏的小函数（结构同真实组件） ───────── */
function setTab(t) {
  $$('.vg-tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.t === t)));
  $('#pane-progress').hidden = t !== 'progress'; $('#pane-structure').hidden = t !== 'structure';
}
function setStatus(tone, headline, sub = '') {
  $('#st-dot').className = `vg-dot vg-dot-${tone}`;
  $('#st-h').textContent = headline;
  $('#st-sub').textContent = sub; $('#st-sub').hidden = !sub;
}
function addReq(id, text) {
  $('#reqs').hidden = false;
  $('#req-list').append(el(`<article class="vg-item" id="req-${id}"><div class="vg-row"><span class="vg-text"></span><span class="vg-badge vg-badge-doing">还在做</span></div></article>`));
  $(`#req-${id} .vg-text`).textContent = text;
}
function reqTry(id) {
  const row = $(`#req-${id}`), badge = $('.vg-badge', row);
  badge.className = 'vg-badge vg-badge-try'; badge.textContent = '可以试用了';
  row.append(el('<p class="vg-sub">按主对话里说的重点试一试；不满意直接在主对话说</p>'), el('<button class="vg-link" type="button">没问题了</button>'));
}
function buildStructure() {
  $('#pane-structure').innerHTML = `<section>
    <div class="vg-empty" id="ov-empty"><p>还没有生成概览。生成后能看到项目分成哪几部分、各自做到什么程度。</p><button class="vg-primary" id="ov-gen">生成项目概览</button></div>
  </section>`;
}
async function showOverview() {
  const box = $('#pane-structure section');
  box.innerHTML = `<p class="vg-summary">每周总结网页：组员填名字和本周总结并提交，你在一页里按人查看。现在是能在这台电脑上试用的第一版，全组各自提交还没实现。</p><div class="vg-layers" id="layers"></div>`;
  const layers = $('#layers');
  let n = 0;
  for (const [i, group] of LAYERS.entries()) {
    const g = el('<div></div>');
    if (i > 0) g.append(el(`<div class="vg-link-down vg-part-in" style="animation-delay:${n * 90}ms">↓ ${group.link}</div>`));
    g.append(el(`<div class="vg-label vg-part-in" style="animation-delay:${n * 90}ms">${group.label}</div>`));
    for (const part of group.parts) {
      const node = part.tag === 'missing'
        ? el(`<div class="vg-part vg-part-missing vg-part-in" id="part-${part.id}"><span class="vg-part-main"><span class="vg-part-title">${part.title}</span><span class="vg-part-sub">${part.purpose}</span></span>${TAGS.missing}</div>`)
        : el(`<button type="button" class="vg-part vg-part-in" id="part-${part.id}" aria-pressed="false"><span class="vg-part-main"><span class="vg-part-title">${part.title}</span><span class="vg-part-sub">${part.purpose}</span></span>${TAGS[part.tag]}</button>`);
      node.style.animationDelay = `${n++ * 90}ms`;
      g.append(node);
    }
    layers.append(g);
  }
  layers.append(el(`<p class="vg-legend vg-part-in" style="animation-delay:${n * 90}ms">● 能用　◐ 模拟或示意　○ 还没做　· 由 AI 根据代码推测</p>`));
  await sleep(n * 90 + 360);
}

/* ═════════════════════════ 正片 ═════════════════════════ */
async function main() {
  buildShell(); buildStructure();
  const vgc = $('#vgc'), center = $('#center');

  /* ── 片头 ── */
  const four = '<div class="four five"><span><b>01</b>先问清楚</span><span><b>02</b>做到哪了</span><span><b>03</b>说人话</span><span><b>04</b>一张图看懂</span><span><b>05</b>看不懂就问</span></div>';
  $('#hero').innerHTML = `<h1>VibeGuide</h1><div class="acc long">Make technical systems legible to non-technical people.</div><div class="zh">不懂技术，也能用 AI 做开发</div>${four}`;
  await sleep(400);
  $('#hero').classList.add('show');
  shot('00-hero', 1800);
  await sleep(4300);
  $('#hero').classList.remove('show');
  await sleep(600);

  /* ── 场景：它在哪，怎么开始 ── */
  $('#viewport').classList.add('show'); $('#capbar').classList.add('show');
  await sleep(700);
  $('#cursor').classList.add('show');
  say('它装在 <b>DeepSeek Harness</b> 里：主对话照常用，右边多一个侧栏');
  await sleep(600);
  ring($('#rsb'), 2200, -4, 8);
  callout($('#rtab-vg'), '右侧栏里的 <b>VibeGuide</b>', { side: 'left', ms: 2200, gap: 16 });
  shot('01-shell', 900);
  await sleep(2900);

  say('开工前，把模式切到 <b>VibeGuide</b>');
  await click($('#modechip'));
  const menu = el(`<div class="modemenu"><div class="on"><b>标准模式</b><small>默认的开发方式</small></div><div id="pick-vg"><b>VibeGuide</b><small>用你看得懂的话沟通，侧栏同步进展</small></div></div>`);
  $('#ccard').append(menu);
  await sleep(1100);
  await click($('#pick-vg'));
  menu.remove();
  $('#modechip').innerHTML = `VibeGuide${ic('chev', 13)}`; $('#modechip').classList.add('mode-on');
  $('#hmode').innerHTML = `${BOOK(13, 1.8)}VibeGuide`;
  $('#vg-gate').hidden = true; $('#vg-main').hidden = false; $('#vg-foot').hidden = false; $('#vg-gear').hidden = false;
  shot('02-mode', 700);
  await sleep(1500);

  say('然后像平时一样，直接说你想做什么');
  await click($('#ctext'), { ax: .2 });
  await type($('#ctext'), IDEA, { cps: 15 });
  $('#send').classList.remove('off');
  await sleep(450);
  await click($('#send'));
  setComposer(''); addUser(IDEA);
  $('#stitle').textContent = TITLE; $('#srow-t').textContent = TITLE; $('#vg-name').textContent = TITLE;
  setRunning(true);
  $('#st-first').hidden = true; $('#intro').hidden = false;
  setStatus('active', 'AI 正在处理');
  addReq('r1', IDEA);
  const t1 = addTurn();
  const th0 = addStep(t1, 'spark', '深度求索中，用时 1 秒 ···');
  moveTo({ x: 700, y: 430 });
  shot('03-sent', 700);
  await sleep(1400);

  /* ════════ 01 先问清楚 ════════ */
  await chapter(1, '开工前', '先问清楚', 'ask what matters.', '想法还模糊？它不会闷头就做：<b>只问会改变结果的事</b>', () => cam({ s: 1.17, x: W, y: 0 }, 10));
  $('span', th0).textContent = '已思考 · 用时 3 秒';
  say('它没有闷头就做，而是<b>先问你两件事</b>');
  const md0 = el('<div class="md"></div>'); t1.append(md0);
  await stream(md0, '<p>开工前，先确认两件会影响做法的事。</p>', { cps: 60, onStep: () => pin(flow()) });
  let qcard = showQuestion(t1, 0);
  setStatus('active', '等你在主对话选择');
  await sleep(700);
  ring(qcard, 2600, 4, 18);
  shot('03b-question', 700);
  await sleep(2600);
  say('问的不是技术，是<b>你答得上来的事</b>；每个选项都写着选了会怎样');
  await moveTo($('.qopt', qcard), { ax: .5 });
  await sleep(3400);
  say('拿不准？侧栏也列着这道题，可以让它<b>帮你看懂这些选项</b>');
  ring($('#help-choice'), 2600, 5, 9);
  shot('03c-sidebar-choice', 700);
  await sleep(3400);
  say('选好了，在主对话里点一下');
  await click($('.qopt', qcard), { ax: .3 });
  $('.qopt', qcard).classList.add('pick');
  await sleep(700);
  qcard = showQuestion(t1, 1);
  shot('03d-question2', 600);
  await sleep(2000);
  await click($('.qopt', qcard), { ax: .3 });
  $('.qopt', qcard).classList.add('pick');
  await sleep(700);
  qcard.outerHTML = `<div class="qdone">${QS.map(q => `<span>${ic('check', 13, 1.9)}${q.short[0]}<b>${q.short[1]}</b></span>`).join('')}</div>`;
  $('#choices').innerHTML = '';
  setStatus('active', 'AI 正在处理');
  say('答完两题，它才开工');
  const th1 = addStep(t1, 'spark', '深度求索中，用时 1 秒 ···');
  let thinking = true;
  (async () => { for (let s = 2; thinking; s++) { await sleep(1000); if (thinking) $('span', th1).textContent = `深度求索中，用时 ${s} 秒 ···`; } })();
  moveTo({ x: 700, y: 470 });
  shot('03e-answered', 600);
  await sleep(2200);

  /* ════════ 02 做到哪了 ════════ */
  await chapter(2, '做的过程中', '做到哪了', 'always in view.', '屏幕在滚，你不用猜：<b>AI 在忙什么、你的要求到哪一步</b>，一直在旁边', () => camSide(1.42, 0, 10));
  thinking = false; $('span', th1).textContent = '已思考 · 用时 4 秒';
  say('主 AI 开工了。侧栏第一行，就是<b>它现在在干什么</b>');
  const md1 = el('<div class="md"></div>'); t1.append(md1);
  await stream(md1, '<p>明白了。先做能在你电脑上试用的第一版：填写页和汇总页。</p>', { cps: 64, onStep: () => pin(flow()) });
  setStatus('active', '正在修改');
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'package.json', 520);
  setStatus('active', '正在修改', '改了 1 个文件');
  ring($('.vg-status'), 2600, 6, 10);
  callout($('.vg-status'), '蓝点在跳 = <b>AI 还在忙</b>', { side: 'left', ms: 2600, gap: 18 });
  shot('04-working', 500);
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'src/App.jsx', 640);
  setStatus('active', '正在修改', '改了 2 个文件');
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'src/FillForm.jsx', 700);
  setStatus('active', '正在修改', '改了 3 个文件');
  await sleep(500);
  say('你提过的要求，在下面<b>一条条记着</b>');
  ring($('#req-r1'), 2400, 5, 8);
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'src/Summary.jsx', 760);
  setStatus('active', '正在修改', '改了 4 个文件');
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'src/storage.js', 700);
  setStatus('active', '正在修改', '改了 5 个文件');
  await sleep(700);
  say('做完一段，它会自己<b>检查一遍</b>');
  setStatus('active', '正在检查', '改了 5 个文件');
  await runStep(t1, 'term', '正在运行命令', '执行了命令', 'npm run build', 1500);
  const md2 = el('<div class="md"></div>'); t1.append(md2);
  await stream(md2, reply('m'), { cps: 150, chunk: 3, onStep: () => pin(flow()) });
  t1.append(el(`<div class="acts"><span class="dur">已完成，用时 1分08秒</span><span class="ib">${ic('copy', 15)}</span><span class="ib">${ic('thumb', 15)}</span><span class="ib">${ic('redo', 15)}</span></div>`));
  pin(flow()); setRunning(false);
  setStatus('ok', '上次检查通过', 'AI 已停下 · 改了 5 个文件');
  reqTry('r1');
  say('AI 说做好了，这里写的是「<b>可以试用了</b>」：等你亲自试过才算数');
  await sleep(500);
  ring($('#req-r1 .vg-badge'), 2600, 4, 12);
  shot('05-try', 600);
  await sleep(3800);

  /* ════════ 03 说人话 ════════ */
  shot('06z-chapter', 1500);
  await chapter(3, '做完后', '说人话', 'plain and honest.', '同样的事实，换成<b>你看得懂的说法</b>', () => camFull(10));
  const board = el(`<div class="cmp">
    <div class="col dim" id="col-std"><h5>标准模式<small>同一轮工作的回答</small></h5><div class="body"><div class="tech" id="tech"></div></div></div>
    </div>`);
  const colVg = el(`<div class="col" id="col-vg"><h5>${BOOK(16, 1.8)}VibeGuide 模式<small>同样的事实</small></h5><div class="body"><div class="md plain" id="plain"></div></div></div>`);
  const count = node => Math.round(node.textContent.replace(/\s/g, '').length / 10) * 10;
  $('#overlay').append(board);
  $('#cursor').classList.remove('show');
  say('同一轮工作，换成<b>标准模式</b>，回答通常是这样的');
  await sleep(500);
  const techBody = $('#col-std .body');
  await stream($('#tech'), TECH, { cps: 230, chunk: 4, onStep: () => pin(techBody) });
  $('#col-std h5 small').textContent = `约 ${count($('#tech'))} 字`;
  shot('07-standard', 500);
  await sleep(1100);
  say('内容都对，但得<b>先懂技术</b>才读得下去');
  callout($('#col-std'), '<b>术语一个接一个</b>，没做完的埋在细节里', { side: 'right', ms: 3000, gap: -290, shift: 150 });
  shot('07b-standard-note', 600);
  await sleep(3600);
  say('<b>VibeGuide 模式</b>下，同样的事实这样说');
  board.append(colVg);
  await sleep(450);
  await stream($('#plain'), reply('c'), { cps: 95, chunk: 2 });
  $('#col-vg h5 small').textContent = `约 ${count($('#plain'))} 字`;
  shot('07c-both', 600);
  await sleep(2400);
  say('先说<b>你能看到什么、怎么试</b>');
  ring($('#c-what'), 2500, 8, 10);
  shot('08-what', 600);
  await sleep(3000);
  say('出现术语，顺手讲清<b>对你意味着什么</b>');
  ring($('#c-term'), 2700, 8, 10);
  shot('08b-term', 600);
  await sleep(3200);
  say('只是样子的、还没做的，它<b>主动摊开说</b>');
  ring($('#c-honest'), 2900, 8, 10);
  shot('09-honest', 600);
  await sleep(3500);
  board.classList.add('out'); await sleep(320); board.remove();
  $('#cursor').classList.add('show');

  /* ════════ 04 一张图看懂 ════════ */
  await chapter(4, '随时', '一张图看懂', 'the whole picture.', '不用看代码：项目<b>分成哪几块、每块做到哪一步</b>', () => camFull(10));
  say('想看全貌？点侧栏的「<b>项目结构</b>」');
  await click($('.vg-tabs [data-t=structure]'));
  setTab('structure');
  await camSide(1.42, 0, 850);
  await click($('#ov-gen'));
  $('#ov-gen').disabled = true;
  const wait = el('<p role="status" class="vg-muted">正在整理项目概览…</p>');
  $('#pane-structure').prepend(wait);
  shot('10-generating', 500);
  await sleep(1700);
  wait.remove();
  say('从<b>你看得到的页面</b>，到<b>数据存在哪里</b>，一层层排好');
  await showOverview();
  moveTo({ x: 800, y: 560 });
  shot('11-structure', 600);
  await sleep(2400);
  scrollEnd(vgc, 1300);
  await camSide(1.42, H, 1300);
  shot('12-structure-end', 500);
  await sleep(1500);
  say('每一块都标着：<b>能用</b>、<b>模拟</b>，还是<b>还没做</b>');
  ring($('#part-shared'), 2600, 4, 10);
  callout($('#part-shared'), '你要了，但<b>还没做</b>', { side: 'left', ms: 2600, gap: 16 });
  shot('13-missing', 600);
  await sleep(3300);
  scrollTo(vgc, 0, 1000);
  await camSide(1.42, 40, 1000);
  say('「模拟」是：界面上有了，<b>其实还不能用</b>。点开看看');
  await sleep(400);
  const week = $('#part-week');
  ring(week, 1600, 4, 10);
  await sleep(1300);
  await click(week, { ax: .35 });
  week.setAttribute('aria-pressed', 'true');
  const detail = el(`<div class="vg-detail"><p><span class="vg-sub">对使用的影响：</span>按钮已经在页面上，但点了不会换到别的周，现在只能看本周。</p>
    <p class="vg-sub">AI 推测：页面里有切换按钮，没找到按周读取总结的代码。</p><button class="vg-link" type="button">问问这部分</button></div>`);
  week.after(detail);
  await sleep(500);
  say('它会说清<b>对你用起来有什么影响</b>，不让你被“看起来有”骗到');
  moveTo({ x: 780, y: 520 });
  shot('14-detail', 700);
  await sleep(4300);

  /* ════════ 05 看不懂就问 ════════ */
  const term = $('#term');
  await chapter(5, '随时', '看不懂就问', 'ask right there.', '划一下就能问。问答<b>不进主对话</b>，想清楚了再一键交给 AI', () => {
    week.setAttribute('aria-pressed', 'false'); detail.remove(); vgc.scrollTop = 0; setTab('progress');
    cam({ s: 1.42, x: 150, y: lrect(term).y - 300 }, 10);
  });
  say('主 AI 的话里有看不懂的词？<b>划一下</b>');
  await moveTo(term, { ax: 0, ay: .55, dx: -1 });
  $('#cursor').classList.add('down'); await sleep(160);
  term.classList.add('on');
  await moveTo(term, { ax: 1, ay: .55, dx: 2, ms: 340 });
  $('#cursor').classList.remove('down');
  await sleep(260);
  const cr = lrect(center), tr = lrect(term);
  const askBtn = el(`<button type="button" class="vg-ask" data-above="true">${BOOK(14, 1.8)}问问这个</button>`);
  center.append(askBtn);
  askBtn.style.left = (tr.x - cr.x + tr.w / 2) + 'px'; askBtn.style.top = (tr.y - cr.y - 8) + 'px';
  shot('15-select', 600);
  await sleep(1700);
  await click(askBtn);
  askBtn.remove(); term.classList.remove('on');
  $('#intro').hidden = true;
  $('#quote-slot').innerHTML = '<div class="vg-quote"><span>「localStorage」</span><button type="button" class="vg-icon">×</button></div>';
  const ta = $('#vg-ta');
  ta.classList.add('focus'); ta.innerHTML = '<span class="ph">直接发送会问“这是什么意思？”，也可以写下你的问题</span>';
  $('#vg-send').disabled = false;
  await cam({ s: 1.3, x: W, y: H }, 900);
  say('它带着这个词进了侧栏。直接发送，就是问“<b>这是什么意思</b>”');
  ring($('#vg-foot form'), 2400, 4, 12);
  shot('16-quote', 700);
  await sleep(3100);
  say('也可以问你真正关心的');
  await click(ta, { ax: .25, ay: .3 });
  moveTo(ta, { ax: .8, ay: .9, ms: 320 });
  await type(ta, QUESTION, { cps: 11 });
  shot('16b-typed', 300);
  await sleep(700);
  await click($('#vg-send'));
  $('#quote-slot').innerHTML = ''; ta.classList.remove('focus'); ta.innerHTML = `<span class="ph">${ASK_PH}</span>`;
  $('#vg-send').textContent = '停止讲解'; $('#vg-send').classList.remove('vg-primary');
  $('#vg-busy').innerHTML = '<p role="status" class="vg-muted">正在讲解你的问题…</p>';
  shot('17-asking', 500);
  await sleep(1300);
  await camSide(1.42, 0, 900);
  $('#vg-busy').innerHTML = ''; $('#vg-send').textContent = '发送'; $('#vg-send').classList.add('vg-primary'); $('#vg-send').disabled = true;
  $('#answers').innerHTML = `<div class="vg-label">讲解</div><div class="vg-list"><details class="vg-item vg-answer" open>
    <summary><span><small class="vg-sub">关于「localStorage」<br></small>${QUESTION}</span></summary><div class="vg-md" id="ans"></div></details></div>`;
  say('回答结合的是<b>你的项目</b>，而且只在侧栏里，不打乱主对话');
  moveTo({ x: 760, y: 500 });
  await stream($('#ans'), `<p><strong>现在还不能。</strong>总结只存在你这台电脑的浏览器里。组员在自己电脑上打开，看到的是一份各存各的空白记录，你也看不到他们交的内容。</p>
    <p>想让 8 个人都能交，得把总结存到全组都能访问的地方。</p>`, { cps: 70 });
  shot('18-answer', 600);
  await sleep(2600);
  $('#ans').after(el(`<div class="vg-suggestion" id="sug"><p>可以这样改：${SUGGESTION}</p><button type="button" id="sug-send">发到主对话</button></div>`));
  say('想清楚要改？点「<b>发到主对话</b>」，改法它替你写好');
  await sleep(500);
  ring($('#sug'), 2200, 4, 10);
  shot('19-suggestion', 600);
  await sleep(2700);
  await click($('#sug-send'));
  $('#sug-send').textContent = '正在写给主 AI…'; $('#sug-send').disabled = true;
  await sleep(1300);
  await camFull(850);
  $('#sug-send').outerHTML = '<span class="vg-sub">已发到主对话</span>';
  $('#receipts').innerHTML = `<article class="vg-receipt"><div class="vg-receipt-state vg-receipt-accepted">已发到主对话</div><p class="vg-text">${SUGGESTION}</p>
    <details class="vg-attached"><summary>同时带上了 1 条之前的约定</summary></details></article>`;
  const sent = addUser(HANDOFF);
  setRunning(true); setStatus('active', 'AI 正在处理', '改了 5 个文件');
  addReq('r2', SUGGESTION);
  const t2 = addTurn();
  addStep(t2, 'spark', '深度求索中，用时 1 秒 ···');
  say('一句话变成<b>写清楚的要求</b>，之前的约定也一并带上');
  await sleep(500);
  ring($('.bubble', sent), 3000, 5, 22);
  moveTo({ x: 930, y: 655 });
  shot('20-handoff', 700);
  await sleep(4000);
  say('这条新要求也记进了清单，状态是「<b>还在做</b>」');
  await scrollEnd(vgc, 900);
  ring($('#req-r2'), 2400, 5, 8);
  shot('21-listed', 600);
  await sleep(3200);
  say('看得懂，跟得上，<b>说了算</b>');
  shot('21z-last', 900);
  await sleep(2800);

  /* ── 片尾 ── */
  $('#cursor').classList.remove('show');
  say(''); $('#capbar').classList.remove('show');
  $('#viewport').classList.remove('show');
  await sleep(500);
  $('#frame').classList.add('dark', 'end');
  $('#hero').className = 'end';
  $('#hero').innerHTML = `<h1>VibeGuide</h1><div class="acc long">Make technical systems legible to non-technical people.</div>${four}
    <div class="rules"><span>Mac + DeepSeek Harness 桌面版</span><span>一行命令安装</span><span>开源免费</span></div>
    <div class="cmd"><b>$</b>curl -fsSL https://raw.githubusercontent.com/wwyking123/VibeGuide/release/install.sh | sh</div>
    <div class="fine">github.com/wwyking123/VibeGuide · 画面为功能示意，对话内容为演示编排</div>`;
  await sleep(500);
  $('#hero').classList.add('show');
  shot('22-outro', 2300);
  await sleep(6500);
}

boot(main);
