// Plain-language cards for each detector. Every `fill` text is complete: no placeholders left for
// the user to edit (PRD 7.8). Variables are filled server-side; missing ones drop the sentence.

export const SAFEWORDS = {
  'stop-plan': { label: '停下说计划', text: '先别改代码。用白话告诉我现在卡在哪、你打算怎么做，给我 2 个方案选。' },
  'new-approach': { label: '换个思路', text: '刚才的方法试了几次都不行，请换一种做法，并说明为什么这次能行。' },
  rollback: { label: '回到能用的版本', text: '回到最后一次能正常运行的状态，然后告诉我回退了什么。' },
}

const CONTINUE = '请从刚才中断的地方继续，先告诉我上一步做到哪了。'
const fill = (label, text) => ({ kind: 'fill', label, text })
const steps = (label, list) => ({ kind: 'steps', label, steps: list })
const safeword = (id) => ({ kind: 'fill', label: SAFEWORDS[id].label, text: SAFEWORDS[id].text, safeword: id })
const clip = (s, n = 80) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

const RETRY_CAUSE = {
  RATE_LIMIT: ['模型服务有点忙', '模型服务限制了短时间内的请求次数（限流）。'],
  TRANSPORT: ['网络不太稳', 'DSH 这一下没连上模型服务。'],
  SERVER: ['模型服务暂时出错', '模型服务商那边返回了错误。'],
  TIMEOUT: ['模型服务响应慢', '模型服务很久没有返回数据。'],
  EMPTY_RESPONSE: ['模型没返回内容', '模型这次返回了空内容。'],
}

export const TEMPLATES = {
  A1: (v) => ({
    severity: 'block', title: '网络断了，AI 没法继续回复',
    why: `DSH 连不上模型服务${v.retries ? `，自动重试了 ${v.retries} 次都没成功` : ''}。多半是网络断了或不稳定，也可能是代理、公司网络拦截了。`,
    impact: '刚才这一步没做完，之前做好的内容不受影响。',
    actions: [fill('继续', `网络刚才断了。${CONTINUE}`),
      steps('先检查网络', ['看看其他网页能不能打开', '用了代理或 VPN 的话，确认它在正常工作', '网络恢复后，点上面「继续」下的「填入主对话」，再按回车'])],
  }),
  A2: (v) => {
    const [cause, why] = RETRY_CAUSE[v.code] ?? ['请求出了点问题', '模型请求没有成功。']
    return {
      severity: 'info', title: `${cause}，AI 正在自动重试（第 ${v.retry}/${v.max ?? 5} 次）`,
      why: `${why}DSH 会自动重试，一般不用你处理。`,
      impact: '之前做好的内容不受影响。先等一会儿；如果重试都失败了，这里会再提醒你怎么办。',
      actions: [steps('现在要做什么', ['不用做什么，等它重试完', '重试都失败的话，这张卡会换成具体的处理办法'])],
    }
  },
  A3: () => ({
    severity: 'block', title: '请求太频繁，模型服务让等一会儿',
    why: '模型服务限制了短时间内的请求次数（限流），DSH 已经自动重试过，还是不行。这不是你的项目出了问题。',
    impact: '这一步没做完。等 1–2 分钟再继续，一般就好了。',
    actions: [fill('继续', CONTINUE), steps('经常出现的话', ['等 1–2 分钟再继续', '在主对话输入框右下角换一个模型'])],
  }),
  A4: () => ({
    severity: 'block', title: '模型账户额度用完了',
    why: '模型服务返回「余额不足」。这是账户的问题，不是你的项目出了问题。',
    impact: '在充值或换模型之前，主 AI 没法继续工作。',
    actions: [steps('你需要自己处理', ['打开模型服务商的控制台（例如 DeepSeek 开放平台），查看余额并充值', '或者在主对话输入框右下角，换成还有额度的模型', '处理好后，回来点「继续」下的「填入主对话」']),
      fill('继续', `额度已经处理好了。${CONTINUE}`)],
  }),
  A5: (v) => ({
    severity: 'block', title: v.code === 'MISSING_CREDENTIAL' ? '还没有配置模型账号' : '模型账号登录失效了',
    why: v.code === 'MISSING_CREDENTIAL' ? 'DSH 还没有可用的模型账号或密钥（API Key），所以没法调用模型。'
      : '模型服务不认这次的登录信息：可能是密钥（API Key）填错了、被删除了，或者登录过期了。',
    impact: '处理好之前，主 AI 没法继续工作。',
    actions: [steps('你需要自己处理', ['打开 DSH 的设置 → 模型', '重新登录，或者重新填写密钥（API Key）', '处理好后，回来点「继续」下的「填入主对话」']),
      fill('继续', CONTINUE)],
  }),
  A6: () => ({
    severity: 'block', title: '模型服务那边出故障了',
    why: '这是模型服务商那边的问题，不是你的项目出了问题。DSH 已经自动重试过。',
    impact: '这一步没做完，之前做好的内容不受影响。',
    actions: [fill('继续', CONTINUE), steps('还是不行的话', ['过几分钟再试', '在主对话输入框右下角换一个模型'])],
  }),
  A7: () => ({
    severity: 'block', title: '模型服务很久没有响应',
    why: '模型服务长时间没有返回任何内容，DSH 判定超时了。可能是网络很慢，也可能是服务那边卡住了。',
    impact: '这一步没做完，之前做好的内容不受影响。',
    actions: [fill('继续', CONTINUE), steps('还是不行的话', ['检查网络', '过几分钟再试，或换一个模型'])],
  }),
  A8: () => ({
    severity: 'block', title: 'AI 回复到一半断了',
    why: '模型的回复没有完整传回来。通常是网络抖了一下。',
    impact: '刚才那一步可能没做完。',
    actions: [fill('继续', '你刚才的回复中断了，请继续完成，先告诉我做到哪了。')],
  }),
  A9: () => ({
    severity: 'block', title: '这段对话太长，AI 快装不下了',
    why: 'AI 一次能看的内容有上限（上下文窗口），现在的对话已经超过了。',
    impact: '继续在这个对话里做，AI 会出错或者忘掉前面的内容。',
    actions: [fill('先让它总结', '请用 5 句话总结这个项目目前做到哪了、还剩什么没做、有哪些我定过的要求。我要开新会话继续。'),
      steps('然后开新会话', ['点左上角「新会话」', '在 VibeGuide 的「想清楚」里，把需求简报填进新会话', '再把上一步的总结贴进去'])],
  }),
  A10: () => ({
    severity: 'warn', title: 'AI 这次要说的太长，被截断了',
    why: 'AI 一次回复的长度有上限，这次超过了，后面的内容没写出来。',
    impact: '刚才的工作可能只做了一部分。',
    actions: [fill('分步做', '你上一条回复被截断了。请把剩下的工作分成几步，先只完成第一步。')],
  }),
  B1: (v) => ({
    severity: 'warn', title: '电脑上缺一个它要用的工具',
    why: `命令「${clip(v.command, 60)}」运行失败：系统找不到它需要的程序或依赖${v.detail ? `（${clip(v.detail, 60)}）` : ''}。`,
    impact: '依赖它的功能现在跑不起来。',
    actions: [fill('让它装好', `刚才的命令因为缺少依赖失败了${v.detail ? `（${clip(v.detail, 60)}）` : ''}。请你自己安装缺少的东西，并用白话告诉我装了什么、为什么需要它。`)],
  }),
  B2: () => ({
    severity: 'warn', title: '网页要用的端口被别的程序占了',
    why: '端口像门牌号，同一个号同时只能给一个程序用。可能是之前启动的网页还开着。',
    impact: '网页这次没能启动。',
    actions: [fill('换个端口', '端口被占用了。请换一个端口启动，并告诉我新的打开地址。')],
  }),
  B3: (v) => ({
    severity: 'warn', title: '它没有权限操作这个位置',
    why: `系统拒绝了这次操作（权限不足）${v.detail ? `：${clip(v.detail, 80)}` : '。'}`,
    impact: '这一步没做成。',
    actions: [fill('换个位置', '刚才的操作因为权限不足失败了。请改用当前项目文件夹里的位置，不要修改系统目录，并告诉我你改了什么。')],
  }),
  B4: () => ({
    severity: 'info', title: '它要找的文件不存在',
    why: 'AI 要读或要用的文件不在它以为的位置。',
    impact: '一般它会自己调整；反复出现的话可能在乱找。',
    actions: [fill('先看清楚', '你刚才要找的文件不存在。请先确认项目里实际有哪些文件，再继续。')],
  }),
  B5: () => ({
    severity: 'warn', title: '下载东西失败了，多半是网络问题',
    why: '安装依赖时连不上下载服务器，常见原因是网络不稳或者访问国外的下载源太慢。',
    impact: '需要的依赖没装上，相关功能跑不起来。',
    actions: [fill('换镜像重试', '刚才安装依赖时网络失败了。请换成国内镜像（例如 npmmirror）重试，并告诉我改了什么设置。'),
      steps('也可以先检查网络', ['看看其他网页能不能打开', '用了代理的话确认它在正常工作'])],
  }),
  B6: (v) => ({
    severity: 'warn', title: `同一个问题已经失败 ${v.count} 次了`,
    why: `AI 在反复尝试「${clip(v.command, 60)}」，但一直没成功。继续让它硬试，可能会越改越乱。`,
    impact: '项目可能卡在这一步了。',
    actions: [safeword('stop-plan'), safeword('new-approach'), safeword('rollback')],
  }),
  C8: (v) => ({
    severity: 'warn', title: `AI 已经 ${v.minutes} 分钟没有新进展`,
    why: '主 AI 还在运行，但这段时间没有任何新的输出或操作。可能在等一个很慢的命令，也可能是网络卡住了。',
    impact: '先等一会儿；等太久的话，可以在主对话里点停止，再让它说明情况。',
    actions: [fill('说明情况', '你刚才很久没有进展。请告诉我卡在哪一步，然后继续。'),
      steps('如果要停下', ['在主对话里点停止按钮', '再点上面「说明情况」下的「填入主对话」，按回车'])],
  }),
  D1: (v) => ({
    severity: 'warn', title: 'AI 在等你允许它做一件事',
    why: `它想使用「${v.tool ?? '某个工具'}」${v.reason ? `，原因：${clip(v.reason, 80)}` : ''}。这需要你在主对话里点「允许」或「拒绝」。`,
    impact: '你处理之前，AI 会一直停在这里。',
    actions: [steps('怎么处理', ['回到主对话，找到授权提示', '看不懂提示的话，选中那段文字，点「解释」'])],
  }),
  D2: () => ({
    severity: 'info', title: 'AI 问了你一个问题，还在等你回答',
    why: '主 AI 需要你做个决定才能继续。',
    impact: '你回答之前，AI 会一直等着。',
    actions: [steps('怎么处理', ['回到主对话回答它的问题', '看不懂选项的话，选中文字点「解释」'])],
  }),
  // F2-15: the generic card used whenever no model explanation is available.
  X: (v) => ({
    severity: 'warn', title: 'AI 这一轮报错了',
    why: '这一轮没有正常结束，VibeGuide 没认出是哪类问题。原始错误信息在下方「依据」里。',
    impact: '这一步可能没做完，之前做好的内容一般不受影响。',
    actions: [fill('让它解释', `刚才这一轮报错了${v.code ? `（错误代码 ${v.code}）` : ''}。请用白话告诉我是什么原因、对项目有什么影响，再继续处理。`), safeword('stop-plan')],
  }),
}

export function render(detector, vars = {}) {
  const t = TEMPLATES[detector]
  if (!t) throw new Error('unknown detector ' + detector)
  return t(vars)
}
