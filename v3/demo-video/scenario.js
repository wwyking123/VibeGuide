// VibeGuide 宣传示意片 —— 演示脚本
// 结构：完整的 DSH 窗口 + 右侧 VibeGuide 侧栏，四段依次演示
//   01 想清楚 → 02 卡住了 → 03 看不懂 → 04 做了什么
// 例子：想做个网页，让小组每周交工作总结。
// 文案原则：用日常的词（不说"需求简报""路线卡"这类生造词），底部字幕按宣传片的口吻写。

const PLACEHOLDER = '发消息或创建任务, / 调用指令, @ 文件或对话';
const IDEA = '想做个网页，让我们组 8 个人每周交工作总结，我一页看完';
const TITLE = '每周总结网页';

// 问清楚之后，交给主 AI 的是一段润色好的完整需求（而不是带字段的表格）
const POLISHED = `请帮我做一个网页，用来收集我们组每周的工作总结。

我们组有 8 个人。每人每周打开网页，填上名字和这周的总结，点提交就行，不用登录。我要在一个页面里按人看到全组的总结，还能翻看往周。

第一版先做三样：填写页、汇总页、按周切换。登录、AI 概括、统计图表先不做。数据存在运行网页的这台电脑上，我先在自己电脑上试用。

怎么算做好：8 个人都能提交；刷新或重开后，内容还在。

有会影响结果、而我没说到的地方，请先问我，最多 2 个问题。技术方案你定，但请用大白话告诉我对使用有什么影响。`;

const QS = [
  { t: '大家怎么交总结？', a: ['怎么交总结', '网页上填'], opts: [['在网页上直接填', '格式统一，最省事', 1], ['上传自己的文档', '由网页来整理，做起来更复杂'], ['从飞书自动拉取', '要管理员开权限，最费时']] },
  { t: '交上来的总结，谁能看？', a: ['谁能看', '只有你'], opts: [['只有你', '最简单，不用区分身份', 1], ['全组互相可见', '每个人都能看到所有人的'], ['每人只看自己的', '要先能认出谁是谁']] },
  { t: '你想怎么看这些总结？', a: ['怎么看', '按人排好'], opts: [['按人排好，一页看完', '第一版就能做出来', 1], ['再加一段 AI 写的概括', '要接 AI 服务，会多花钱'], ['还要统计完成了几项', '要先约定填写格式']] },
  { t: '大家怎么打开来填？', follow: 1, a: ['怎么打开来填', '发链接，填名字'], opts: [['发个链接，填名字就行', '不用登录；可能有人填错名字', 1], ['每人登录账号', '防冒名，但要多做一个登录']] },
  { t: '先在哪用？', follow: 1, a: ['先在哪用', '你的电脑上'], opts: [['先在你的电脑上试', '今天就能看到效果', 1], ['直接放到网上', '需要部署，步骤更多']] },
];

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
    <header class="chead"><div><span id="stitle">新会话</span><span class="sub">weekly-notes</span></div><span class="ib">${ic('panelR')}</span></header>
    <div id="flow"><div class="empty" id="hero-mark"><img src="assets/dsh-logo.png" alt=""></div></div>
    <div class="composer"><div class="ccard" id="ccard">
      <div class="ctext" id="ctext"><span class="ph">${PLACEHOLDER}</span></div>
      <div class="cbar"><span class="ib">${ic('clip')}</span><span class="chip">${ic('folder')}weekly-notes</span><span class="chip">DeepSeek${ic('chev', 13)}</span><span class="send off" id="send">${ic('up', 16, 1.9)}</span></div>
    </div></div>
  </main>
  <aside class="rsb" id="rsb">
    <div class="rtabs">
      <div class="rtab on" id="rtab-vg">${VGM}VibeGuide<i class="tdot"></i></div>
      <div class="rtab">${ic('file', 15)}文件</div><div class="rtab">${ic('term', 15)}终端</div>
      <span class="sp"></span><span class="ib">${ic('plus', 15)}</span><span class="ib">${ic('full', 14)}</span>
    </div>
    <section class="vg">
      <div class="vg-head"><span class="vg-proj" id="vg-proj">weekly-notes</span><span class="vg-status" id="vg-status"><i class="dot"></i>正常</span></div>
      <div id="vg-alerts"></div>
      <nav class="vg-tabs"><div class="vg-tab on" data-t="think">想清楚</div><div class="vg-tab" data-t="did">做了什么</div><div class="vg-tab" data-t="ask">问一问</div></nav>
      <div class="vg-body"><div class="vg-pane on" id="pane-think"></div><div class="vg-pane" id="pane-did"></div><div class="vg-pane" id="pane-ask"></div></div>
      <div class="vg-askbar" id="askbar"><span id="asktx"><span class="ph">问点什么…</span></span><span class="send sm off" id="asksend">${ic('up', 13, 1.9)}</span></div>
    </section>
  </aside>`;
}

/* ───────── 界面操作的小函数 ───────── */
const flow = () => $('#flow');
function setTab(t) {
  $$('.vg-tab').forEach(x => x.classList.toggle('on', x.dataset.t === t));
  $$('.vg-pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + t));
  $('#askbar').classList.toggle('on', t === 'ask');
}
const setStatus = (kind, text) => { $('#vg-status').innerHTML = `<i class="dot ${kind}"></i>${text}`; };
function setRunning(on) {
  $('#srow').classList.toggle('running', on);
  const s = $('#send');
  s.classList.toggle('off', !on);
  s.innerHTML = on ? '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="#fff"/></svg>' : ic('up', 16, 1.9);
}
function setComposer(text, long) {
  const c = $('#ctext');
  if (!text) { c.innerHTML = `<span class="ph">${PLACEHOLDER}</span>`; c.classList.remove('long'); $('#send').classList.add('off'); return; }
  c.textContent = text; c.classList.toggle('long', !!long); $('#send').classList.remove('off');
}
function addUser(text, clip) {
  $('#hero-mark')?.remove();
  const r = el(`<div class="urow"><div class="bubble ${clip ? 'clip' : ''}"><div class="bt"></div></div></div>`);
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
async function fillComposer(fromBtn, label, text, note, long) {
  await fly(fromBtn, $('#ccard'), label);
  setComposer(text, long);
  const card = $('#ccard'); card.classList.add('flash');
  sleep(1600).then(() => card.classList.remove('flash'));
  if (note) callout(card, note, { side: 'top', ms: 2500, gap: 10 });
}
function alertCard(html) { const a = el(html); $('#vg-alerts').prepend(a); return a; }
function showQ(i) {
  const q = QS[i];
  $('#q-slot').innerHTML = `<div class="qcard"><div class="q-t">${q.follow ? '<small>追问 · 根据你刚才的回答</small>' : ''}${q.t}</div>
    ${q.opts.map(o => `<div class="opt"><i class="rad"></i><div><b>${o[0]}</b>${o[2] ? '<em>推荐</em>' : ''}<p>${o[1]}</p></div></div>`).join('')}
    <div class="q-f"><span>我来说…</span><span>你来定</span></div></div>`;
  $$('#q-dots i:not(.gap)').forEach((d, k) => d.classList.toggle('on', k <= i));
  $('#q-n').textContent = `${i + 1} / 5`;
}
async function answer(i, read) {
  showQ(i);
  await sleep(read);
  const o = $('#q-slot .opt');
  await click(o, { ax: .4 });
  o.classList.add('pick');
  await sleep(520);
  $('#answers').append(el(`<div class="ans">${ic('check', 13, 1.9)}<span>${QS[i].a[0]}</span><b>${QS[i].a[1]}</b></div>`));
}

/* ═════════════════════════ 正片 ═════════════════════════ */
async function main() {
  buildShell();
  const think = $('#pane-think'), did = $('#pane-did'), ask = $('#pane-ask');
  think.innerHTML = `
    <h3>想做点什么？</h3>
    <p class="hint">说一句想法就行。我先帮你问清关键的事，再整理成一段完整的话交给主 AI。</p>
    <div class="chips"><span>小工具</span><span>数据看板</span><span>表单收集</span><span>其他</span></div>
    <div class="idea-box" id="idea"><span class="ph">比如：想做个网页，让大家每周交工作总结</span></div>
    <div class="row"><span class="pill pri" id="start">开始梳理</span><span class="hint">不写代码，不占用主对话</span></div>`;
  did.innerHTML = `<p class="hint">看不懂主 AI 说了什么？点它回复下面的「白话版」，这里会用大白话再讲一遍。</p>`;
  ask.innerHTML = `<p class="hint">划词点「继续问」，或直接在下面提问。这里的问答不进主对话。</p>`;

  /* ── 片头 ── */
  const four = '<div class="four"><span><b>01</b>想清楚</span><span><b>02</b>卡住了</span><span><b>03</b>看不懂</span><span><b>04</b>做了什么</span></div>';
  $('#hero').innerHTML = `<h1>VibeGuide</h1><div class="acc">a guide beside your AI.</div><div class="zh">不会写代码，也能放心让 AI 帮你做东西</div>${four}`;
  await sleep(400);
  $('#hero').classList.add('show');
  shot('00-hero', 1800);
  await sleep(4100);
  $('#hero').classList.remove('show');
  await sleep(600);

  /* ── 场景：VibeGuide 在哪 ── */
  $('#viewport').classList.add('show'); $('#capbar').classList.add('show');
  await sleep(700);
  $('#cursor').classList.add('show');
  say('它就在 <b>DeepSeek Harness 的右侧栏</b>：主对话照常用，它在旁边帮你');
  await sleep(600);
  ring($('#rsb'), 2300, -4, 8);
  callout($('#rtab-vg'), '右侧栏里的 <b>VibeGuide</b>', { side: 'left', ms: 2300, gap: 16 });
  shot('01-shell', 900);
  await sleep(3000);

  /* ════════ 01 想清楚 ════════ */
  await chapter(1, '开工前', '想清楚', 'ask first.', '一句模糊的想法 → 问清楚、<b>润色好</b>，再交给主 AI');
  say('有个想法？先在侧栏里<b>说一句</b>就行');
  await camSide(1.15, 0);
  await click($('.chips span:nth-child(1)'));
  $('.chips span:nth-child(1)').classList.add('on');
  await click($('#idea'), { ax: .3, ay: .4 });
  $('#idea').classList.add('focus');
  await type($('#idea'), IDEA, { cps: 13 });
  await sleep(450);
  shot('02-idea', 200);
  await click($('#start'));
  think.innerHTML = `<div class="vg-load"><i class="spin"></i>先看看项目文件夹里有没有现成的东西…</div>`;
  await sleep(900);
  think.innerHTML = `<div class="vg-load"><i class="spin"></i>文件夹是空的，直接开始</div>`;
  await sleep(800);

  think.innerHTML = `<div class="qh">${VGM}<b>先问清楚</b><span class="dots" id="q-dots"><i></i><i></i><i></i><i class="gap"></i><i></i><i></i></span><em id="q-n">1 / 5</em></div>
    <div id="answers"></div><div id="q-slot"></div>`;
  say('它只问<b>会改变结果</b>的问题：一次一题，每个选项都写清后果');
  shot('03-q1', 1500);
  await answer(0, 3000);
  await answer(1, 1900);
  await answer(2, 1700);
  $('#q-slot').innerHTML = `<div class="vg-load"><i class="spin"></i>根据你的回答，再追问 2 个…</div>`;
  await sleep(1000);
  say('问题<b>跟着你的回答走</b>：这 2 题，是上一轮的选择引出来的');
  shot('04-q4', 1400);
  await answer(3, 2400);
  await answer(4, 1900);

  say('一共只问 <b>5 个问题</b>。先复述一遍，确认没理解偏');
  think.innerHTML = `
    <div class="note-ok">${ic('check', 14, 1.9)}<span>问了 <b>5</b> 题，够开工了</span></div>
    <div class="vcard"><div class="vh">${VGM}<b>我的理解</b></div><div class="restate" id="rs"></div></div>
    <div class="row" id="rs-btns" style="visibility:hidden"><span class="sp"></span><span class="pill sm">改一句</span><span class="pill pri sm" id="rs-ok">对，就是这样</span></div>`;
  await stream($('#rs'), '你要做一个网页：组员每周在上面填工作总结，你在一页里按人看到全组的。不用登录，填名字就行；先在你的电脑上试用。', { cps: 62 });
  $('#rs-btns').style.visibility = '';
  shot('05-restate', 500);
  await sleep(1300);
  await click($('#rs-ok'));

  think.innerHTML = `
    <div class="note-ok">${ic('check', 14, 1.9)}<span>5 个问题的答案，都写进去了</span></div>
    <div class="vcard"><div class="vh">${VGM}<b>整理好的需求</b><em>已润色 · 可编辑</em></div>
      <div class="said"><small>你原来说的</small>${IDEA}</div>
      <div class="pol" id="pol"></div></div>
    <div class="row" id="pol-btns" style="visibility:hidden"><span class="pill pri" id="fill1">填入主对话</span><span class="pill">${ic('copy', 14)}复制</span><span class="sp"></span><span class="pill ghost sm">再改改</span></div>`;
  say('然后，把你的回答<b>润色成一段完整的需求</b>');
  moveTo({ x: 640, y: 560 });
  await sleep(500);
  await stream($('#pol'), POLISHED.split('\n\n').map(p => `<p>${p}</p>`).join(''), { cps: 150, chunk: 3 });
  shot('06-polished', 600);
  await sleep(700);
  callout($('#pol'), '一句话 → <b>一段主 AI 能直接照做的话</b>', { side: 'left', ms: 2500, gap: 18 });
  await sleep(2900);

  say('点「填入主对话」——只是<b>填进输入框</b>，发不发由你');
  $('#pol-btns').style.visibility = '';
  await camFull(900);
  await click($('#fill1'));
  await fillComposer($('#fill1'), '整理好的需求', POLISHED, '已填入输入框 · <b>不会自动发送</b>', true);
  shot('07-filled', 900);
  await sleep(2400);
  await click($('#send'));
  setComposer('');
  addUser(POLISHED, true);
  $('#stitle').textContent = TITLE; $('#srow-t').textContent = TITLE; $('#vg-proj').textContent = TITLE;
  setRunning(true); setStatus('busy', 'AI 工作中');
  $('.note-ok span', think).innerHTML = '这份需求已记下，后面用它<b>对照进度</b>';
  const t1 = addTurn();
  const th1 = addStep(t1, 'spark', '深度求索中，用时 1 秒 ···');
  let thinking = true;
  (async () => { for (let s = 2; thinking; s++) { await sleep(1000); if (thinking) $('span', th1).textContent = `深度求索中，用时 ${s} 秒 ···`; } })();
  moveTo({ x: 700, y: 430 });
  await sleep(1300);

  /* ════════ 02 卡住了 ════════ */
  await chapter(2, '做的过程中', '卡住了', 'catch it early.', '主 AI 出了状况：<b>自动发现</b>，说人话，给一条一键出路');
  thinking = false; $('span', th1).textContent = '已思考 · 用时 4 秒';
  say('主 AI 照着你的需求，开工了');
  const md1 = el('<div class="md"></div>'); t1.append(md1);
  await stream(md1, '<p>好的，我按你的需求来做第一版：先搭好网页骨架，再做填写页。</p>', { cps: 64, onStep: () => pin(flow()) });
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'package.json', 460);
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'src/App.jsx', 520);
  await runStep(t1, 'file', '正在写入文件', '已写入文件', 'src/FillForm.jsx', 560);
  await runStep(t1, 'term', '正在运行命令', '执行了命令', 'npm install', 1200);
  say('做到一半，<b>网络断了</b>');
  const rt = addStep(t1, 'redo', '正在重试模型请求', '第 2 次', true);
  await sleep(700); $('code', rt).textContent = '第 3 次';
  const gray = alertCard(`<div class="al quiet"><i class="sdot gray"></i><span>网络不太稳，AI 正在自动重试（第 3 次）</span></div>`);
  await sleep(700); $('code', rt).textContent = '第 4 次'; $('span', gray).textContent = '网络不太稳，AI 正在自动重试（第 4 次）';
  await sleep(700); $('code', rt).textContent = '第 5 次'; $('span', gray).textContent = '网络不太稳，AI 正在自动重试（第 5 次）';
  await sleep(800);
  rt.remove();
  t1.append(el(`<div class="terr"><i></i><b>本轮运行失败</b><span>模型请求失败：网络连接中断（fetch failed）</span><code>TRANSPORT</code></div>`));
  pin(flow()); setRunning(false);
  await sleep(650);
  gray.remove();
  const net = alertCard(`<div class="al" id="al-net"><div class="al-h"><i class="sdot red"></i><b>网络断了，AI 没法继续回复</b></div>
    <p>刚才那一步没做完；已写好的文件不受影响。</p>
    <dl class="al-more"><dt>为什么</dt><dd>和模型服务的连接断开，已重试 5 次</dd><dt>怎么办</dt><dd>先检查 Wi-Fi；恢复后点「填入“继续”」</dd><dt>依据</dt><dd><code>TRANSPORT · fetch failed</code></dd></dl>
    <div class="al-f"><span class="pill pri sm" id="fill-net">填入「继续」</span><span class="pill sm" id="ev-btn">详情${ic('chev', 12)}</span><span class="x">忽略</span></div></div>`);
  $('#rtab-vg').classList.add('alert'); setStatus('red', '需要处理');
  say('不用截图去别处问：侧栏<b>几秒内</b>就有提醒');
  await sleep(500);
  ring(net, 1500, 4, 16);
  shot('08-alert-full', 800);
  await sleep(1800);
  await camSide(1.3, 0);
  say('只说两件事：<b>发生了什么</b>，<b>对你有什么影响</b>；出路是一个按钮');
  shot('09-alert-zoom', 600);
  await sleep(3500);
  say('想看原因，点「详情」。这类状况靠规则识别，<b>不花模型额度</b>');
  await click($('#ev-btn'));
  net.classList.add('open');
  moveTo({ x: 760, y: 470 });
  shot('10-alert-open', 800);
  await sleep(3200);

  await camFull(800);
  say('不只是断网：<b>20 多种</b>状况，它都替你盯着');
  const cats = [
    ['A', '网络和账号', '断网 · 请求太频繁 · 额度用完 · 登录失效 · 对话太长'],
    ['B', '电脑环境', '缺工具 · 没权限 · 找不到文件 · 同一步反复失败'],
    ['C', 'AI 的做法', '原地打转 · 做偏了 · 多做了没要求的 · 说了但没做'],
    ['D', '等你处理', '等你点同意 · 等你回答'],
    ['E', '你的情绪', '连说“还是不行” → 给一句现成的话，一键重来'],
  ];
  const board = el(`<div class="board"><h4><b>20+</b>种状况，自动发现</h4>${cats.map((c, i) => `<div class="cat" style="animation-delay:${.15 + i * .14}s"><i>${c[0]}</i><b>${c[1]}</b><span>${c[2]}</span></div>`).join('')}
    <div class="legend"><span><i style="background:#ec1313"></i>红：AI 没法继续了</span><span><i style="background:#f59e0b"></i>黄：方向或结果有问题</span><span><i style="background:#b4b9c1"></i>灰：值得知道</span></div></div>`);
  $('#overlay').append(board);
  shot('11-board', 1700);
  await sleep(5000);
  board.classList.add('out'); await sleep(320); board.remove();

  say('网络好了点一下：一句“请继续”<b>填进输入框</b>，由你发出');
  await click($('#fill-net'));
  await fillComposer($('#fill-net'), '一句现成的话', '请从刚才中断的地方继续。', '只填入，<b>由你按回车</b>');
  shot('12-fill-continue', 900);
  await sleep(2000);
  await click($('#send'));
  setComposer(''); addUser('请从刚才中断的地方继续。');
  setRunning(true); setStatus('busy', 'AI 工作中'); $('#rtab-vg').classList.remove('alert');
  net.outerHTML = `<div class="al quiet" id="al-ok"><i class="sdot green"></i><span>网络已恢复，AI 接着做了</span></div>`;
  sleep(3000).then(async () => { const g = $('#al-ok'); if (g) { g.classList.add('out'); await sleep(360); g.remove(); } });
  say('AI 接着做，提醒<b>自动收起</b>');
  moveTo({ x: 700, y: 300 });
  const t2 = addTurn();
  const th2 = addStep(t2, 'spark', '深度求索中，用时 1 秒 ···');
  await sleep(1100); $('span', th2).textContent = '已思考 · 用时 2 秒';
  await runStep(t2, 'file', '正在写入文件', '已写入文件', 'src/storage.js', 540);
  await runStep(t2, 'file', '正在写入文件', '已写入文件', 'src/App.jsx', 500);
  await runStep(t2, 'term', '正在运行命令', '执行了命令', 'npm run build', 1150);
  const md2 = el('<div class="md"></div>'); t2.append(md2);
  await stream(md2, `<p>填写页做好了，打开 <a>http://localhost:5173</a> 就能试：</p>
    <ul><li>用 React 搭了页面，用 Vite 起了开发服务器</li>
    <li>表单有「名字」和「本周总结」两项，填完点提交</li>
    <li>提交的内容用 <span class="sel" id="term">localStorage</span> 保存在浏览器里，刷新不会丢</li></ul>
    <p>构建检查通过，已适配手机。接下来做汇总页吗？</p>`, { cps: 76, onStep: () => pin(flow()) });
  t2.append(el(`<div class="acts"><span class="dur">已完成，用时 1分12秒</span><span class="ib">${ic('copy', 15)}</span><span class="ib">${ic('thumb', 15)}</span><span class="ib">${ic('redo', 15)}</span><span class="vgbtn" id="plain">${VGM}白话版</span></div>`));
  pin(flow()); setRunning(false); setStatus('', '正常');
  shot('13-turn-done', 600);
  await sleep(1300);

  /* ════════ 03 看不懂 ════════ */
  await chapter(3, '做的过程中', '看不懂', 'in plain words.', '划一下就有<b>白话解释</b>；想追问，也不进主对话');
  say('主 AI 的话里有看不懂的词？<b>划一下</b>');
  const term = $('#term'), center = $('#center');
  await cam({ s: 1.45, x: 125, y: lrect(term).y - 330 }, 900);
  await moveTo(term, { ax: 0, ay: .55, dx: -1 });
  $('#cursor').classList.add('down'); await sleep(160);
  term.classList.add('on');
  await moveTo(term, { ax: 1, ay: .55, dx: 2, ms: 340 });
  $('#cursor').classList.remove('down');
  await sleep(220);
  const cr = lrect(center), tr = lrect(term);
  const menu = el(`<div class="lens-menu">${VGM}<span class="pri" id="lm-exp">解释</span><span class="dim">继续问</span><span class="dim">复制</span></div>`);
  center.append(menu);
  menu.style.left = (tr.x - cr.x + tr.w / 2 - menu.offsetWidth / 2) + 'px'; menu.style.top = (tr.y - cr.y - 42) + 'px';
  shot('14-select', 600);
  await sleep(1500);
  await click($('#lm-exp'));
  menu.remove();
  const L2 = '大家交的总结存在这台电脑的浏览器里：刷新不丢，换电脑就看不到', L3 = '不用。和你的需求里“先在自己电脑上试用”一致';
  const card = el(`<div class="lens-card"><div class="lh">${VGM}<b>localStorage</b><em>结合你的项目</em></div>
    <dl><dt>这是什么</dt><dd>浏览器自带的一块存储空间</dd><dt>在你的项目里</dt><dd id="lc2">${L2}</dd><dt>要你做什么吗</dt><dd id="lc3">${L3}</dd></dl>
    <div class="lf"><span class="pill pri sm" id="lc-ask">继续问</span><span class="pill sm">${ic('thumb', 13)}有用</span><small>不进主对话</small></div></div>`);
  center.append(card);
  card.style.left = Math.max(20, tr.x - cr.x + tr.w / 2 - 202) + 'px'; card.style.top = (tr.y - cr.y - card.offsetHeight - 10) + 'px';
  say('三句话讲明白：<b>这是什么 · 在你的项目里 · 要你做什么吗</b>');
  await sleep(300);
  await stream($('#lc2'), L2, { cps: 70 });
  await stream($('#lc3'), L3, { cps: 70 });
  shot('15-explain', 500);
  await sleep(3600);
  say('还想接着问？带着这个词去<b>侧栏</b>聊');
  await click($('#lc-ask'));
  card.remove(); term.classList.remove('on');
  setTab('ask');
  ask.innerHTML = `<div class="s-quote"><small>你划选的内容 · 来自 AI 的回复</small><b>localStorage</b></div>`;
  await cam({ s: 1.12, x: W, y: H }, 950);
  await click($('#asktx'), { ax: .2 });
  await type($('#asktx'), '那换电脑怎么办？', { cps: 10 });
  $('#asksend').classList.remove('off');
  await sleep(320);
  await click($('#asksend'));
  $('#asktx').innerHTML = '<span class="ph">接着问…</span>'; $('#asksend').classList.add('off');
  ask.append(el(`<div class="s-q">那换电脑怎么办？</div>`));
  const ld = el(`<div class="vg-load"><i class="spin"></i>结合你的项目想一想…</div>`); ask.append(ld);
  await sleep(850); ld.remove();
  const ans = el('<div class="s-a"></div>'); ask.append(ans);
  say('追问多少轮都行，<b>不会发给主 AI</b>，主线不被带偏');
  moveTo({ x: 700, y: 520 });
  await stream(ans, `<p><b>换电脑就看不到了。</b>它只存在这一台电脑的这一个浏览器里。</p><p>现在只在你自己的电脑上试用，够用。等要发给全组用，再让主 AI 换成大家都能访问的存储。</p>`, { cps: 64 });
  ask.append(el(`<div class="s-note">${ic('lock', 13)}这里的问答不会发给主 AI</div>`));
  shot('16-ask', 600);
  await sleep(3200);

  /* ════════ 04 做了什么：把主 AI 说的话，换成白话 ════════ */
  const plain = $('#plain');
  await chapter(4, '做完后', '做了什么', 'what just happened.', '主 AI 说了一大段？点一下，<b>换成白话</b>再讲一遍', () => cam({ s: 1.35, x: 91, y: lrect(plain).y - 400 }, 10));
  say('主 AI 回了一大段，没太看懂它到底做了什么？');
  moveTo({ x: 840, y: 330 });
  shot('17-reply', 900);
  await sleep(2700);
  say('点回复下面的「<b>白话版</b>」');
  ring(plain, 1500, 4, 18);
  await sleep(800);
  await click(plain);
  plain.classList.add('on');
  setTab('did');
  did.innerHTML = `<div class="vg-load"><i class="spin"></i>正在把这段话换成白话…</div>`;
  moveTo({ x: 500, y: 356 });
  await camSide(1.3, 0, 900);
  did.innerHTML = `<div class="rc" id="rc"><small>白话版 · 主 AI 刚才那段话</small><h4>填写页做好了，可以试了</h4><ol id="rcs"></ol></div>`;
  say('同一段话，换成白话：<b>做了什么 → 对你意味着什么</b>');
  for (const [a, b] of [['搭好了网页的架子', '浏览器里能打开填写页了'], ['加了「名字 + 本周总结」的表单', '大家填完点提交'], ['内容存在这台电脑的浏览器里', '刷新不丢，换电脑看不到'], ['检查过一遍，没问题 ✓', '它确实运行过检查']]) {
    await sleep(300);
    $('#rcs').append(el(`<li><b>${a}</b><span>${b}</span></li>`));
    await sleep(600);
  }
  shot('18-plain', 500);
  await sleep(1500);
  $('#rc').append(el(`<div class="rc-sec" id="rcp"><label>对照你的需求</label><div class="rc-prog"><span class="pg ok">✓ 填写页</span><span class="pg">○ 汇总页</span><span class="pg">○ 按周切换</span></div></div>`));
  say('对照你的需求，一眼看到<b>做到哪了</b>');
  ring($('#rcp'), 2200, 6, 10);
  await sleep(2900);
  $('#rc').append(el(`<div class="rc-warn" id="rcw"><i class="sdot amber"></i><span><b>只是说说，没看到它做</b>：“已适配手机”</span></div>`));
  say('它嘴上说了、却<b>没看到它做</b>的，会单独提醒你');
  await sleep(900);
  const claim = alertCard(`<div class="al" id="al-claim"><div class="al-h"><i class="sdot amber"></i><b>AI 说“已适配手机”，但没看到它检查过</b></div>
    <p>这一轮的操作记录里，没有相关改动或检查。</p>
    <div class="al-f"><span class="pill pri sm" id="fill-claim">填入「请实际检查」</span><span class="x">忽略 · 提醒错了</span></div></div>`);
  setStatus('amber', '1 条提醒'); $('#rtab-vg').classList.add('warn');
  shot('19-claim', 800);
  await sleep(3000);
  await camFull(800);
  await click($('#fill-claim'));
  await fillComposer($('#fill-claim'), '一句现成的话', '请实际检查一次手机上的显示效果，并把结果告诉我。', '发不发、改不改，<b>都由你决定</b>');
  say('一键填入“请实际检查”，发不发<b>仍然由你</b>');
  claim.classList.add('compact'); $('.al-h b', claim).textContent = '已填入输入框：请实际检查手机显示';
  $('#rtab-vg').classList.remove('warn');
  shot('20-claim-filled', 900);
  await sleep(2800);

  say('每一轮的白话版都会留下来：<b>换个会话，也能接着做</b>');
  did.append(el(`<div class="ov"><div class="ov-h">做到哪了<small>对照你的需求 · 1 / 3</small></div><div class="bar"><i></i></div>
    <div class="tl-row"><i></i>填写页做好了<time>今天 14:32</time></div>
    <div class="row" id="ov-btns"><span class="pill sm">${ic('out', 13)}导出</span><span class="pill sm">换个会话接着做</span></div></div>`));
  moveTo({ x: 640, y: 420 });
  await cam({ s: 1.12, x: W, y: H }, 900);
  ring($('#ov-btns'), 2300, 5, 16);
  shot('21-overview', 700);
  await sleep(3300);
  await camFull(800);
  await sleep(500);

  /* ── 片尾 ── */
  $('#cursor').classList.remove('show');
  say(''); $('#capbar').classList.remove('show');
  $('#viewport').classList.remove('show');
  await sleep(500);
  $('#frame').classList.add('dark', 'end');
  $('#hero').className = 'end';
  $('#hero').innerHTML = `<h1>VibeGuide</h1><div class="acc">a guide beside your AI.</div>${four}
    <div class="rules"><span>只填入，不代发</span><span>不改主 AI 的行为</span><span>只认实际操作记录</span><span>数据只留在本机</span></div>
    <div class="fine">界面为功能示意 · 实际效果以实现为准</div>`;
  await sleep(500);
  $('#hero').classList.add('show');
  shot('22-outro', 2300);
  await sleep(6500);
}

boot(main);
