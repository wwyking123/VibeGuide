import type { GuideInput, GuideSnapshot } from './contracts.js';

type Decision = Pick<GuideInput, 'kind' | 'message' | 'choiceId' | 'choiceVersion' | 'candidateModification'>;
const clarify = (message = '你希望哪个功能变成什么样？请描述希望用户看到或做到的效果。', candidateModification = false): Decision => ({ kind: 'clarify', message, candidateModification });
const explain = (): Decision => ({ kind: 'explain' });
const clean = (s: string) => s.trim().replace(/[。.!！?？]+$/u, '').trim();
const question = /为什么|为何|怎么|如何|什么|是不是|是否|会不会|能不能|可不可以|意味着|有什么|有何|\b(?:why|how|what|whether)\b|[?？]|吗[，,。！？?]?$/i;
const permission = /^(?:同意|批准|允许|授权).*(?:权限|访问|读取|执行命令|运行命令|摄像头|麦克风)|^(?:批准|同意授权|允许访问|允许执行|approve|grant permission)$/i;
const directive = /^(?:(?:那就|那么就|现在|请|麻烦|请帮我|帮我|我希望|我想要|我想|我需要|我要|好的[，,]?|可以[，,]|能不能帮我|可以帮我|能帮我|please)\s*)*(?:把.{1,100}(?:改|换|调|设|删|加|去掉)|将.{1,100}(?:改|换|调|设|删)|改成|改为|换成|(?:定位并|排查并|检查并)?(?:修复|修好|解决)|增加|添加|新增|加(?:上|个|一个)|去掉|删掉|删除|取消|保留|不要(?:让)?|不允许|只允许|实现|开发|做(?:一个|个)|change\b|add\b|remove\b|delete\b|make\b|implement\b|fix\b|repair\b)/i;
const unresolved = /^(?:这个|那个|这样|那样|不太合适|不对|不喜欢|就这样|就这么|按这个|按那个|按上面|按刚才)|(?:改成|改为|换成|按)(?:这样|那样|这个|那个|上面|刚才|第[一二三四五六七八九十\d]+(?:个|种))|(?:把|将)(?:它|这个|那个)(?:改|换|删|去掉)/;

const ordinalAnswer = /^(?:我(?:选择|选)|选择|选|就选|就用|用)?\s*(?:第)?([一二三四五六七八九十\d]+)(?:个|项|种)?(?:方案)?(?:吧|就行|可以)?$/u;
const discussion = (value: string) => /^(?:[“"「『>]|```|文档(?:里|中)?(?:写|说)|AI\s*(?:说|建议)|主\s*AI\s*(?:说|建议)|他(?:说|建议)|她(?:说|建议)|例如|比如|假如|假设)/i.test(value)
  || /(?:只是|只想|仅仅|先)(?:了解|问|讨论|解释)|不要(?:执行|开始开发|改代码|修改文件|(?:改动|修改)(?:任何)?(?:代码|文件)|真的改|修复|修好)|先(?:别|不要)(?:改|开发|执行|修复|修好)|我(?:没|不是)(?:让|说|要)/.test(value);
const complaint = /(?:太|有点|有些|不够)(?:长|短|大|小|慢|丑|难看|复杂|多|少|暗|亮|挤|乱|清楚|明显)|不(?:能用|行|对|好用|显示|生效|见了|工作)|无法|没法|打不开|找不到|看不到|点不了|失败|报错|出错|白屏|卡住|卡死|崩溃|闪退|有问题|有\s*bug|(?:改|修|调|换|弄|删|加)(?:一下|下)|[短长大小快慢多少]一点/i;

/** Sidebar input is ask-only: it explains, or points original-question answers and approvals back to the main conversation. */
export function routeQuestion(statement: string, snapshot: GuideSnapshot): Decision {
  const value = statement.trim(), bare = clean(value);
  if (discussion(value)) return explain();
  const decision = classifyInput(statement, snapshot);
  if (decision.kind === 'redirect') return decision;
  if (ordinalAnswer.test(bare) || /^(?:我选|选择|选第|就选|就用第)/.test(bare)) return { kind: 'redirect', message: '请回主对话的原问题作答。这句话没有作为开发任务发送。' };
  return explain();
}

/** Main-conversation user messages that should appear as requirements. A miss only hides a card; nothing is sent. */
export function isRequirement(statement: string, snapshot: GuideSnapshot): boolean {
  const value = statement.trim(), decision = classifyInput(statement, snapshot);
  if (decision.kind === 'modify') return true;
  return decision.kind !== 'redirect' && !discussion(value) && !question.test(value) && complaint.test(value);
}

/** Only the owner's submitted words can authorize delivery. Never let a model's guess dispatch work. */
export function classifyInput(statement: string, snapshot: GuideSnapshot, reply?: GuideInput): Decision {
  const value = statement.trim(), bare = clean(value);
  if (reply && /^(?:算了|取消|不用了|先不改|不改了|cancel|never mind)$/i.test(bare)) return { kind: 'cancel', message: '这次澄清已结束，没有转交修改。' };
  if (permission.test(bare)) return { kind: 'redirect', message: '权限确认请回主对话的原生审批入口完成。这句话没有作为开发任务发送。' };
  if (discussion(value)) return explain();
  // Old records may predate repair wording support. Re-evaluate only a single,
  // explicit original request; never authorize an unresolved reference by confirmation.
  const confirmable = reply?.candidateModification || (reply?.statements.length === 1 && classifyInput(reply.statement, snapshot).kind === 'modify');
  if (confirmable && /^(?:确认修改|确定修改|请转交(?:修改)?|按原要求修改|是的[，,]?请修改)$/i.test(bare)) return { kind: 'modify' };
  if (reply && /^(?:只想了解|只是提问|只解释|解释一下|先解释|我只是在问)$/i.test(bare)) return explain();

  const ordinal = ordinalAnswer.exec(bare);
  const matching = snapshot.choices.filter(choice => choice.options.some(option => bare === option.label || bare.replace(/^(?:我选|选择|选|就用)/, '') === option.label));
  const answerLike = !!ordinal || matching.length > 0;
  if (answerLike) {
    const candidates = matching.length ? matching : snapshot.choices;
    if (candidates.length === 1 && snapshot.basis) {
      const target = candidates[0];
      const n = ordinal ? (/^\d+$/.test(ordinal[1]) ? Number(ordinal[1]) : '一二三四五六七八九十'.indexOf(ordinal[1]) + 1) : undefined;
      if (n !== undefined && (n < 1 || n > target.options.length)) return clarify('当前问题没有这个选项，请回主对话核对，或说明你希望达到的效果。');
      return { kind: 'redirect', choiceId: target.id, choiceVersion: target.version,
        message: `请回主对话的“${target.question}”选择。这句话没有作为新的开发任务发送。` };
    }
    return clarify('目前无法唯一确定你指的是哪道题。请回主对话原题选择，或明确描述要修改的功能和效果。');
  }
  if (/^(?:我选|选择|选第|就选|就用第)/.test(bare) && !question.test(value)) return clarify('这句话可能同时包含原题答案和新的要求。你希望回答哪道题，还是修改已有功能？完整原话会保留。');
  if (question.test(value) && value.split(/[。！？?；;\n]/).slice(1).some(part => directive.test(part.trim()))) {
    return clarify('这句话同时包含追问和修改。你希望先了解影响，还是已决定修改？可以回答“只想了解”或“确认修改”。', true);
  }
  if (unresolved.test(bare)) return question.test(value) ? explain() : clarify();
  if (/^(?:(?:请|麻烦|帮我|请帮我|那就|现在|我想|我要|please)\s*)*(?:(?:定位并|排查并|检查并)?(?:修复|修好|解决)(?:一下|它|这个|那个|这里|这部分|那部分|问题|故障|\s)*|(?:fix|repair)\s*(?:it|this|that)?)$/i.test(bare)) return clarify('你希望修复哪个功能？请说说哪里不符合预期，以及希望恢复成什么效果。');
  if (/^(?:如果|等到|假如|将来|以后|先考虑|考虑一下)/.test(bare)) return question.test(value) ? explain() : clarify('这是在讨论可能的方案，还是现在就要修改？如果要修改，请说明已经确定的效果。');
  const action = directive.test(value) || /^(?:让用户|支持用户|支持换|禁止公开|我希望(?:用户|管理员|访客|回答|页面)|我需要(?:用户|管理员|访客|回答|页面))/.test(value);
  const polite = /^(?:能不能|可以|能)帮我/.test(value);
  const remainingQuestion = question.test(polite ? value.replace(/^(?:能不能|可以|能)帮我/, '').replace(/[?？]$/, '') : value);
  if (action && remainingQuestion && !/[，,；;。\n]/.test(value) && !/^(?:请|帮我|麻烦)/.test(value)) return explain();
  if (action && remainingQuestion) return clarify('你希望先了解其中的影响，还是已经决定修改？可以回答“只想了解”或“确认修改”，也可以补充具体要求。', true);
  if (action) return { kind: 'modify' };
  if (question.test(value) || /^(?:解释|讲讲|说说|帮我理解|帮我看懂|对比|比较|介绍|能否|能不能|可不可以|可以.*吗|是否)/.test(value)) return explain();
  return clarify('你是想了解这个方案，还是提出修改？如果要修改，请直接说希望哪个功能变成什么样。');
}

export function modificationContent(statements: string[]): string {
  if (statements.length === 1) return statements[0];
  return `用户在 VibeGuide 侧栏提出的要求（保留原话和全部补充）：\n\n首次原话：\n${statements[0]}\n\n${statements.slice(1).map((s, i) => `补充 ${i + 1}：\n${s}`).join('\n\n')}`;
}
