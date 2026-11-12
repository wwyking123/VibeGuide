// VibeGuide 示意视频 —— 演示脚本（轻量版）
// 故事线不变（取自 PRD 的例子："想做个网页，帮我们组每周汇总周报"）：
//   01 想清楚 → 02 卡住了 → 03 看不懂 → 04 做了什么
// 呈现方式：即时的、一次性的内容就地用轻提示（输入框上方的小卡 / 提示条、划词浮层）；
//           需要留着反复看的内容才放侧栏（多轮追问、白话路线），侧栏平时收起。

P.x = 'M4 4l8 8M12 4l-8 8';
P.lock = 'M4.5 7.5h7v5h-7zM6 7.5V5.6a2 2 0 014 0v1.9';
P.out = 'M6.5 3.5h-2a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1v-2M9 3.5h3.5V7M12.3 3.7L7.5 8.5';

const PLACEHOLDER = '发消息或创建任务, / 调用指令, @ 文件或对话';
const IDEA = '想做个网页，帮我们组 8 个人每周汇总周报';
const BRIEF_TEXT = `【需求简报 v1】周报汇总网页
做什么：组员每周在网页上填周报，组长一页看到全组汇总
第一版：填写页、汇总页、按周切换；先不做登录、AI 总结、统计图表
怎么算好：8 个人都能提交；刷新、重开后内容不丢
已确认：填名字即可，不用登录　暂定：每周一 0 点换新的一周
工作方式：只有影响结果、而这里没写到的才问我，最多 2 个问题；技术选择你定，但请用白话告诉我影响。`;

const QS = [
  { t: '周报从哪来？', opts: [['大家在网页上填', '格式统一，最省事', 1], ['上传自己的文档', '由网页来整理，做起来更复杂'], ['从飞书自动拉取', '要管理员开权限，最费时']] },
  { t: '汇总给谁看？', opts: [['只有你', '最简单，不用区分身份', 1], ['全组互相可见', '每个人都能看到所有人的'], ['每人只看自己的', '要先能认出谁是谁']] },
  { t: '“汇总”是指什么？', opts: [['按人排好，一页看完', '第一版就能做出来', 1], ['再加一段 AI 写的总结', '要接 AI 服务，会多花钱'], ['还要统计完成了几项', '要先约定填写格式']] },
  { t: '大家怎么打开来填？', follow: 1, opts: [['发个链接，填名字就行', '不用登录', 1], ['每人登录账号', '防冒名，但要多做一个登录']] },
  { t: '第一版在哪用？', follow: 1, opts: [['先在你的电脑上试', '今天就能看到效果', 1], ['直接放到网上', '需要部署，步骤更多']] },
];

const SCENES = [null,
  { no: '01', phase: '开工前', title: '想清楚', accent: 'ask first.', desc: '把一句模糊的想法，<br>问成主 AI 能直接执行的需求简报。', where: '输入框上方' },
  { no: '02', phase: '做的过程中', title: '卡住了', accent: 'catch it early.', desc: '主 AI 出了异常：自动发现，说人话，<br>再给一条一键出路。', where: '输入框上方的提示条', dark: true },
  { no: '03', phase: '做的过程中', title: '看不懂', accent: 'in plain words.', desc: '划一下就有白话解释；想追问，也不进主对话。', where: '划词浮层 · 追问在侧栏' },
  { no: '04', phase: '做完后', title: '做了什么', accent: 'what just happened.', desc: '按实际操作记录，<br>把这一轮讲成白话，留在侧栏里。', where: '回复下的按钮 · 路线在侧栏' },
];

/* ───────── 搭舞台 ───────── */
function buildStage() {
  const bar = (modeId, on) => `<div class="cbar"><span class="ib">${ic('clip')}</span><span class="chip">${ic('folder')}weekly-report</span><span class="chip">DeepSeek${ic('chev', 13)}</span><span class="chip vgmode ${on ? 'on' : ''}" id="${modeId}">${VGM}VibeGuide</span>`;
  $('#top').innerHTML = `${VGM}<b>VibeGuide</b><span>DeepSeek Harness 插件 · 功能示意</span><span class="r" id="top-r">01 / 04</span>`;
  $('#tl').innerHTML = `<div class="line"></div><div class="fill" id="tl-fill"></div>
    <div class="phase" style="left:0">开工前</div><div class="phase" style="left:25%">做的过程中</div><div class="phase" style="left:75%">做完后</div>
    ${[0, 25, 50, 75, 100].map(p => `<i class="tick" style="left:${p}%"></i>`).join('')}
    ${['想清楚', '卡住了', '看不懂', '做了什么'].map((t, i) => `<div class="lab" id="lab${i + 1}" style="left:${i * 25}%"><b>0${i + 1}</b>${t}</div>`).join('')}
    <i class="ph" id="tl-ph"></i>`;
  $('#win').innerHTML = `
    <div class="wbar"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>
      <span class="ib">${ic('panelL')}</span><span class="ib">${ic('edit')}</span>
      <span class="wt"><img src="assets/dsh-logo.png" alt=""><span id="wtitle">新会话</span><small>weekly-report</small></span><span class="sp"></span>
      <span class="ib" id="side-btn">${ic('panelR')}<i class="ndot"></i></span></div>
    <div id="wrow">
      <div id="wbody" style="flex:1;display:flex;flex-direction:column;position:relative">
        <div id="flow"></div><div id="dock"></div>
        <div class="composer"><div class="ccard" id="ccard"><div class="ctext" id="ctext"></div>${bar('vgmode', true)}<span class="send off" id="send">${ic('up', 16, 1.9)}</span></div></div></div>
      </div>
      <div id="side"><div id="side-in">
        <div class="s-head">${VGM}<b>VibeGuide</b><span class="sp"></span>${ic('x', 14)}</div>
        <div class="s-tabs"><span data-t="brief">简报</span><span data-t="did">做了什么</span><span data-t="ask">问一问</span></div>
        <div id="side-body"></div>
      </div></div>
    </div>`;
  $('#solo').innerHTML = `<div class="solo-in"><div class="ccard"><div class="ctext"><span class="ph">${PLACEHOLDER}</span></div>${bar('solo-mode', false)}<span class="send off">${ic('up', 16, 1.9)}</span></div></div></div>
    <div class="cap" id="solo-cap">这是 DeepSeek Harness 的输入框</div>`;
}

/* ───────── 讲解层 ───────── */
let ph = 0, phStep = 0;
function setPh(p) { ph = p; $('#tl-ph').style.left = p * 100 + '%'; $('#tl-fill').style.width = p * 100 + '%'; }
async function beat(html) {                       // 左侧那一行"现在发生了什么"
  const b = $('#l-beat');
  b.classList.add('sw'); await sleep(210);
  $('span', b).innerHTML = html; b.classList.remove('sw');
  setPh(ph + phStep);
}
async function setScene(n, beats, build) {
  const s = SCENES[n], L = $('#left'), win = $('#win'), frame = $('#frame');
  L.classList.add('out'); $('#wrow').classList.add('sw');
  await sleep(520);
  const flip = frame.classList.contains('dark') !== !!s.dark;
  frame.classList.toggle('dark', !!s.dark);
  $('#l-no').textContent = s.no; $('#l-phase').textContent = s.phase; $('#l-title').textContent = s.title;
  $('#l-accent').textContent = s.accent; $('#l-desc').innerHTML = s.desc;
  $('#l-where').innerHTML = `<span class="k">内置位置</span>${s.where}`;
  $('#l-beat span').innerHTML = ''; L.classList.remove('more');
  $('#top-r').textContent = `${s.no} / 04`;
  $$('#tl .lab').forEach((l, i) => l.classList.toggle('on', i === n - 1));
  setPh((n - 1) / 4); phStep = .25 / (beats + 1);
  win.classList.add('noanim'); win.classList.remove('side');
  $('#side-btn').classList.remove('on', 'new'); $('#flow').className = ''; $('#dock').innerHTML = ''; $('#side-body').innerHTML = '';
  setComposer(''); setRunning(false);
  build();
  await sleep(flip ? 520 : 140);
  win.classList.remove('noanim');
  L.classList.remove('out'); $('#wrow').classList.remove('sw'); win.classList.add('show');
  await sleep(1000);
}

/* ───────── 窗口里的小动作 ───────── */
const flow = () => $('#flow');
function setComposer(text, long) {
  const c = $('#ctext');
  if (!text) { c.innerHTML = `<span class="ph">${PLACEHOLDER}</span>`; c.classList.remove('long'); $('#send').classList.add('off'); return; }
  c.textContent = text; c.classList.toggle('long', !!long); $('#send').classList.remove('off');
}
function flashComposer() { const k = $('#ccard'); k.classList.add('flash'); sleep(1500).then(() => k.classList.remove('flash')); }
function setRunning(on) {
  const s = $('#send');
  s.innerHTML = on ? '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="#fff"/></svg>' : ic('up', 16, 1.9);
  s.classList.toggle('off', !on);
}
function addUser(text, clip) { const r = el(`<div class="urow"><div class="bubble ${clip ? 'clip' : ''}"><div class="bt"></div></div></div>`); $('.bt', r).textContent = text; flow().append(r); return r; }
function addTurn() { const t = el('<div class="aturn"></div>'); flow().append(t); return t; }
function addStep(turn, icon, verb, arg, running) {
  const s = el(`<div class="step">${ic(icon, 15)}<span>${verb}</span>${arg ? `<code>${arg}</code>` : ''}${running ? '<i class="spin"></i>' : ''}</div>`);
  turn.append(s); return s;
}
async function runStep(turn, icon, ing, done, arg, ms) {
  const s = addStep(turn, icon, ing, arg, true);
  await sleep(ms);
  $('span', s).textContent = done; $('.spin', s).remove();
  return s;
}
function dock(html) { const d = $('#dock'); d.innerHTML = html || ''; return d.firstElementChild; }
async function dockOut() { const c = $('#dock').firstElementChild; if (c) { c.classList.add('out'); await sleep(290); c.remove(); } }
function openSide(tab, html) {
  $$('.s-tabs span').forEach(s => s.classList.toggle('on', s.dataset.t === tab));
  $('#side-body').innerHTML = html || '';
  $('#win').classList.add('side'); $('#side-btn').classList.add('on'); $('#side-btn').classList.remove('new');
}
function showQ(i) {
  const q = QS[i];
  $('#q-body').replaceWith(el(`<div class="q-body" id="q-body"><div class="q-t">${q.t}${q.follow ? '<small>追问 · 根据你刚才的回答</small>' : ''}</div>
    <div class="opts">${q.opts.map(o => `<div class="opt"><i class="rad"></i><b>${o[0]}</b><span>${o[1]}</span>${o[2] ? '<em>推荐</em>' : ''}</div>`).join('')}</div></div>`));
  $$('#q-dots i:not(.gap)').forEach((d, k) => d.classList.toggle('on', k <= i));
  $('#q-n').textContent = `${i + 1} / 5`;
}
async function pick(wait) {
  await sleep(wait);
  const o = $('#q-body .opt');
  await click(o, { ax: .3 });
  o.classList.add('pick');
  await sleep(420);
}

/* ═════════════════════════ 正片 ═════════════════════════ */
async function main() {
  buildStage();

  /* ── 片头：一个输入框，一个开关 ── */
  await sleep(700);
  $('#cursor').classList.add('show');
  await sleep(500);
  await click($('#solo-mode'));
  $('#solo-mode').classList.add('on');
  const cap = $('#solo-cap');
  cap.classList.add('sw'); await sleep(260); cap.textContent = '打开 VibeGuide 模式。其余的，照常用。'; cap.classList.remove('sw');
  shot('00-solo', 900);
  await sleep(2300);
  $('#cursor').classList.remove('show');
  $('#solo').classList.add('out');
  await sleep(420);
  const four = '<div class="four"><span><b>01</b>想清楚</span><span><b>02</b>卡住了</span><span><b>03</b>看不懂</span><span><b>04</b>做了什么</span></div>';
  $('#hero').innerHTML = `<h1>VibeGuide</h1><div class="acc">lightweight, built in.</div><div class="zh">长在 DeepSeek Harness 对话里的轻量导航 · 给不写代码的人</div>${four}`;
  $('#hero').classList.add('show');
  shot('01-hero', 1600);
  await sleep(3700);
  $('#hero').classList.remove('show');
  await sleep(650);
  $('#solo').remove();
  $('#top').classList.add('show'); $('#tl').classList.add('show');

  /* ════════ 01 想清楚：输入框上方的小卡 ════════ */
  await setScene(1, 7, () => {
    $('#wtitle').textContent = '新会话';
    flow().innerHTML = `<div class="empty"><img src="assets/dsh-logo.png" alt=""></div>`;
  });
  $('#cursor').classList.add('show');
  beat('先在输入框里，说一句想法');
  await click($('#ctext'), { ax: .2 });
  await type($('#ctext'), IDEA, { cps: 13 });
  $('#send').classList.remove('off');
  moveTo({ x: 1300, y: 470 });
  await sleep(500);
  dock(`<div class="vg-strip">${VGM}<span class="t">这个想法还缺几个关键决定。先问清，再开工？</span><span class="pill ghost">直接发</span><span class="pill pri" id="askme">问我几题</span></div>`);
  beat('输入框上方，轻轻冒出一条提示');
  shot('02-hint', 900);
  await sleep(2200);
  await click($('#askme'));
  dock(`<div class="vg-card"><div class="vg-h">${VGM}<b>需求梳理</b><span class="dots" id="q-dots"><i></i><i></i><i></i><i class="gap"></i><i></i><i></i></span><em id="q-n">1 / 5</em></div>
    <div id="q-body"></div><div class="vg-f"><span>我来说…</span><span>你来定</span><span>先这样，开做</span></div></div>`);
  showQ(0);
  beat('一次只问一个决定，选项里写清<b>“选了会怎样”</b>');
  shot('03-q1', 1300);
  await pick(2700);
  showQ(1); await pick(1500);
  showQ(2); await pick(900);
  showQ(3);
  beat('问题<b>跟着回答走</b> —— 这次一共只问 5 题');
  shot('04-q4', 700);
  await pick(1700);
  showQ(4); await pick(1000);

  dock(`<div class="vg-card"><div class="vg-h">${VGM}<b>我的理解</b><em>问了 5 题</em></div><div class="restate" id="rs"></div>
    <div class="row" id="rs-btns" style="visibility:hidden"><span class="sp"></span><span class="pill">改一句</span><span class="pill pri" id="rs-ok">对，生成简报</span></div></div>`);
  beat('先复述一遍，确认没理解偏');
  await sleep(350);
  await stream($('#rs'), '你要做一个网页：组员每周在上面填周报，组长在一页里看到全组汇总。填写不用登录，填名字就行；第一版先在你的电脑上试用。', { cps: 64 });
  $('#rs-btns').style.visibility = '';
  shot('05-restate', 500);
  await sleep(1100);
  await click($('#rs-ok'));

  dock(`<div class="vg-card brief"><div class="vg-h">${VGM}<b>需求简报</b><span class="ver">v1</span><em>可编辑 · 已存为项目目标</em></div>
    <div class="b-title">周报汇总网页</div><dl id="bdl"></dl>
    <div class="row b-foot"><span class="tag ok">已确认 4</span><span class="tag tent">暂定 1</span><span class="sp"></span><span class="pill">${ic('copy', 14)}复制</span><span class="pill pri" id="fill1">填入输入框</span></div></div>`);
  beat('一份<b>需求简报</b>：你看得懂，主 AI 也能照着做');
  moveTo({ x: 1290, y: 300 });
  for (const [k, v] of [['做什么', '组员每周在网页上填周报，组长一页看到全组汇总'], ['第一版', '填写页 · 汇总页 · 按周切换'], ['先不做', '账号登录 · AI 总结 · 统计图表'], ['怎么算好', '8 个人都能提交；刷新、重开后内容不丢']]) {
    await sleep(300);
    $('#bdl').append(el(`<dt>${k}</dt>`)); $('#bdl').append(el(`<dd>${v}</dd>`));
  }
  shot('06-brief', 700);
  await sleep(2800);
  await click($('#fill1'));
  await dockOut();
  setComposer(BRIEF_TEXT, true); flashComposer();
  dock(`<div class="vg-strip quiet">${ic('check', 15, 1.9)}<span class="t">已填入输入框。发不发、改不改，都由你决定。</span></div>`);
  beat('只是<b>填进输入框</b> —— VibeGuide 不会替你发');
  shot('07-filled', 900);
  await sleep(2500);
  await click($('#send'));
  dock(''); setComposer(''); flow().innerHTML = ''; addUser(BRIEF_TEXT, true); $('#wtitle').textContent = '周报汇总网页';
  setRunning(true);
  const t0 = addTurn(); addStep(t0, 'spark', '深度求索中，用时 1 秒 ···');
  await sleep(1300);

  /* ════════ 02 卡住了：输入框上方的提示条 ════════ */
  let t1;
  await setScene(2, 7, () => {
    $('#wtitle').textContent = '周报汇总网页';
    flow().innerHTML = ''; addUser(BRIEF_TEXT, true);
    t1 = addTurn();
    addStep(t1, 'spark', '已思考 · 用时 4 秒');
    addStep(t1, 'file', '已写入文件', 'src/App.jsx');
    addStep(t1, 'file', '已写入文件', 'src/FillForm.jsx');
    setRunning(true);
    moveTo({ x: 1300, y: 205 }, { ms: 10 });
  });
  beat('主 AI 按简报开工了');
  await runStep(t1, 'term', '正在运行命令', '执行了命令', 'npm install', 1200);
  const rt = addStep(t1, 'redo', '正在重试模型请求', '第 2 次', true);
  beat('做到一半，<b>网络断了</b>');
  for (const k of [3, 4, 5]) { await sleep(620); $('code', rt).textContent = `第 ${k} 次`; }
  await sleep(700);
  rt.remove();
  t1.append(el(`<div class="terr"><i></i><b>本轮运行失败</b><span>模型请求失败：网络连接中断</span><code>TRANSPORT</code></div>`));
  setRunning(false);
  await sleep(650);
  const al = dock(`<div class="vg-strip" id="al"><i class="sdot red"></i><div class="t"><b>网络断了，AI 没法继续回复</b><small>刚才那一步没做完；之前写好的文件不受影响。</small></div>
    <span class="pill ghost" id="al-more">详情${ic('chev', 12)}</span><span class="pill pri" id="al-fill">填入「继续」</span>
    <dl class="more"><dt>为什么</dt><dd>和模型服务的连接断开了，已自动重试 5 次</dd><dt>怎么办</dt><dd>先检查 Wi-Fi；网络恢复后点「填入“继续”」</dd><dt>依据</dt><dd><code>TRANSPORT · fetch failed · attempts 5</code></dd></dl></div>`);
  beat('不用截图去别处问：提示条<b>说人话</b>');
  shot('08-alert', 900);
  await sleep(3100);
  beat('想看原因和依据，点开「详情」');
  await click($('#al-more'));
  al.classList.add('open');
  moveTo($('#al-fill'), { dy: -34 });
  shot('09-alert-open', 800);
  await sleep(2900);
  beat('点一下，修复指令<b>填进输入框</b>，由你发出');
  await click($('#al-fill'));
  setComposer('请从刚才中断的地方继续。'); flashComposer();
  dock(`<div class="vg-strip quiet">${ic('check', 15, 1.9)}<span class="t">已填入输入框。网络恢复后，按回车发送。</span></div>`);
  await sleep(1900);
  await click($('#send'));
  setComposer(''); addUser('请从刚才中断的地方继续。'); setRunning(true);
  moveTo({ x: 1250, y: 300 });
  const t2 = addTurn(); const th = addStep(t2, 'spark', '深度求索中，用时 1 秒 ···');
  dockOut();
  beat('AI 接着做，提示条<b>自动收起</b>');
  await sleep(1100); $('span', th).textContent = '已思考 · 用时 2 秒';
  await runStep(t2, 'file', '正在写入文件', '已写入文件', 'src/storage.js', 700);
  await sleep(500);
  $('#l-more').innerHTML = `<div class="num"><b>20+</b><span>种异常，自动发现</span></div><div class="cloud">${['断网', '限流', '额度用完', '登录失效', '对话太长', '缺依赖', '端口被占', '反复失败', '原地打转', '思路偏移', '范围蔓延', '空口完成', '等你授权'].map((t, i) => `<span style="animation-delay:${.15 + i * .05}s">${t}</span>`).join('')}</div>`;
  $('#left').classList.add('more');
  beat('断网只是其中一种。规则识别，<b>不花模型额度</b>');
  shot('10-more', 1500);
  await sleep(3900);

  /* ════════ 03 看不懂：划词浮层，追问去侧栏 ════════ */
  await setScene(3, 5, () => {
    flow().innerHTML = ''; flow().classList.add('top');
    const t = addTurn();
    addStep(t, 'spark', '已思考 · 用时 2 秒');
    addStep(t, 'file', '已写入文件', 'src/storage.js');
    addStep(t, 'term', '执行了命令', 'npm run build');
    t.append(el(`<div class="md">填写页做好了，打开 <a>http://localhost:5173</a> 就能试。提交的内容用 <span class="sel" id="term">localStorage</span> 保存在浏览器里。</div>`));
    moveTo({ x: 1180, y: 420 }, { ms: 10 });
  });
  const term = $('#term'), body = $('#wbody');
  beat('AI 的回复里，总有看不懂的词');
  await sleep(1300);
  await moveTo(term, { ax: 0, ay: .55, dx: -1 });
  $('#cursor').classList.add('down'); await sleep(150);
  term.classList.add('on');
  await moveTo(term, { ax: 1, ay: .55, dx: 2, ms: 340 });
  $('#cursor').classList.remove('down');
  await sleep(200);
  let tr = rel(term, body);
  const menu = el(`<div class="lens-menu">${VGM}<span class="pri" id="lm-exp">解释</span><span class="dim">继续问</span><span class="dim">复制</span></div>`);
  body.append(menu);
  menu.style.left = (tr.x + tr.w / 2 - menu.offsetWidth / 2) + 'px'; menu.style.top = (tr.y - 42) + 'px';
  beat('<b>划一下</b>，旁边冒出小菜单');
  shot('11-select', 600);
  await sleep(1500);
  await click($('#lm-exp'));
  menu.remove();
  const card = el(`<div class="lens-card"><div class="vg-h">${VGM}<b>localStorage</b><em>词库 + 你的项目</em></div>
    <dl><dt>这是什么</dt><dd>浏览器自带的一块存储空间</dd><dt>在你的项目里</dt><dd id="lc2"></dd><dt>要你做什么吗</dt><dd id="lc3"></dd></dl>
    <div class="row" style="margin-top:12px"><span class="pill pri" id="lc-ask">继续问</span><span class="pill">${ic('thumb', 13)}有用</span><span class="sp"></span><small style="color:#8a8f98;font-size:12px">不进主对话</small></div></div>`);
  body.append(card);
  card.style.left = Math.max(24, Math.min(tr.x - 70, body.offsetWidth - 436 - 24)) + 'px'; card.style.top = (tr.y + tr.h + 10) + 'px';
  beat('三句话：<b>这是什么 · 在你的项目里 · 要你做什么吗</b>');
  await sleep(300);
  await stream($('#lc2'), '周报存在这台电脑的浏览器里：刷新不丢，换电脑就看不到', { cps: 70 });
  await stream($('#lc3'), '不用。和简报里“先在你的电脑上试用”一致', { cps: 70 });
  shot('12-explain', 500);
  await sleep(3200);
  beat('想多聊几句？「继续问」带着这个词<b>去侧栏</b>');
  await click($('#lc-ask'));
  card.remove();
  openSide('ask', `<div class="s-quote"><small>你划选的内容</small><b>localStorage</b></div>`);
  $('#side-in').append(el(`<div class="s-in" id="s-in"><span id="s-tx"><span class="ph">接着问…</span></span><span class="send sm off" id="s-send">${ic('up', 13, 1.9)}</span></div>`));
  await sleep(900);
  await click($('#s-tx'), { ax: .3 });
  await type($('#s-tx'), '那换电脑怎么办？', { cps: 10 });
  $('#s-send').classList.remove('off');
  await sleep(300);
  await click($('#s-send'));
  $('#s-tx').innerHTML = '<span class="ph">接着问…</span>'; $('#s-send').classList.add('off');
  const sb = $('#side-body');
  sb.append(el(`<div class="s-q">那换电脑怎么办？</div>`));
  const ans = el('<div class="s-a"></div>'); sb.append(ans);
  beat('多轮追问留在侧栏，<b>不进主对话</b>，主线不被带偏');
  await sleep(500);
  await stream(ans, `<p><b>换电脑就看不到了。</b>它只存在这一台电脑的这一个浏览器里。</p><p>第一版只在你的电脑上试用，够用。等要发给全组用，再让主 AI 换成大家都能访问的存储。</p>`, { cps: 66 });
  sb.append(el(`<div class="s-note">${ic('lock', 13)}这里的问答不会发给主 AI</div>`));
  shot('13-ask', 600);
  await sleep(3300);

  /* ════════ 04 做了什么：回复下的按钮，路线留在侧栏 ════════ */
  await setScene(4, 5, () => {
    $('#s-in')?.remove();
    flow().innerHTML = ''; flow().classList.add('top');
    const t = addTurn();
    addStep(t, 'term', '执行了命令', 'npm run build');
    t.append(el(`<div class="md">填写页做好了，打开 <a>http://localhost:5173</a> 就能试。提交的内容用 localStorage 保存在浏览器里，刷新不会丢。构建检查通过，已适配手机。</div>`));
    t.append(el(`<div class="acts"><span class="dur">已完成，用时 1分12秒</span><span class="ib">${ic('copy', 15)}</span><span class="ib">${ic('thumb', 15)}</span><span class="ib">${ic('redo', 15)}</span><span class="vgbtn" id="plain">${VGM}白话版</span></div>`));
    moveTo({ x: 1190, y: 470 }, { ms: 10 });
  });
  beat('AI 说“做好了”。回复下面，多了个<b>「白话版」</b>');
  await sleep(900);
  ring($('#plain'), 1400, 4, 18);
  shot('14-plain', 500);
  await sleep(1300);
  await click($('#plain'));
  $('#plain').classList.add('on');
  openSide('did', `<div class="s-load"><i class="spin"></i>正在按操作记录整理这一轮…</div>`);
  await sleep(1100);
  const sb2 = $('#side-body');
  sb2.innerHTML = `<div class="rc" id="rc"><small>这次做成了</small><h4>组员填写页</h4><ol id="rcs"></ol></div>`;
  beat('路线卡在侧栏：<b>做了什么 → 对你意味着什么</b>');
  moveTo({ x: 1010, y: 520 });
  for (const [a, b] of [['搭了网页骨架', '浏览器里能打开填写页了'], ['加了「名字 + 本周内容」表单', '组员填完点提交'], ['内容存在这台电脑的浏览器里', '刷新不丢，换电脑看不到']]) {
    await sleep(620);
    $('#rcs').append(el(`<li><b>${a}</b><span>${b}</span></li>`));
  }
  await sleep(1500);
  $('#rc').append(el(`<div class="rc-sec"><label>对照简报</label><div class="rc-prog"><span class="pg ok">✓ 填写页</span><span class="pg">○ 汇总页</span><span class="pg">○ 按周切换</span></div></div>`));
  sb2.append(el(`<div class="s-foot">路线总览 · <b>1 / 3</b> 已完成<span class="lnk">${ic('out', 13)}导出</span></div>`));
  beat('只认<b>实际操作记录</b>：对照简报，看做到哪了');
  shot('15-route', 800);
  await sleep(2700);
  $('#rc').append(el(`<div class="rc-warn"><i class="sdot amber"></i><span>AI 自述，未见记录：“已适配手机”</span></div>`));
  await sleep(700);
  dock(`<div class="vg-strip"><i class="sdot amber"></i><div class="t"><b>AI 说“已适配手机”，但没看到它检查过</b><small>这一轮的操作记录里，没有相关改动或检查。</small></div><span class="pill pri" id="al2-fill">填入「请实际检查」</span></div>`);
  beat('AI 嘴上说了、记录里没有的 —— <b>提示条提醒你</b>');
  shot('16-claim', 900);
  await sleep(3000);
  await click($('#al2-fill'));
  setComposer('请实际检查一次手机上的显示效果，并把结果告诉我。'); flashComposer();
  dock(`<div class="vg-strip quiet">${ic('check', 15, 1.9)}<span class="t">已填入输入框。发不发，仍然由你。</span></div>`);
  beat('一键填入“请实际检查”，发不发<b>仍然由你</b>');
  shot('17-claim-filled', 900);
  await sleep(2900);

  /* ── 片尾 ── */
  $('#cursor').classList.remove('show');
  $('#left').classList.add('out'); $('#win').classList.remove('show');
  await sleep(450);
  $('#frame').classList.add('dark', 'end');
  $$('#tl .lab').forEach(l => l.classList.add('on')); setPh(1);
  $('#top-r').textContent = 'VIBEGUIDE';
  $('#hero').className = 'end';
  $('#hero').innerHTML = `<h1>VibeGuide</h1><div class="acc">lightweight, built in.</div>${four}
    <div class="rules"><span>只填入，不代发</span><span>不改主 AI 的行为</span><span>只认实际操作记录</span><span>数据只留在本机</span></div>
    <div class="fine">界面为功能示意 · 实际效果以实现为准</div>`;
  await sleep(500);
  $('#hero').classList.add('show');
  shot('18-outro', 2200);
  await sleep(6500);
}

boot(main);
