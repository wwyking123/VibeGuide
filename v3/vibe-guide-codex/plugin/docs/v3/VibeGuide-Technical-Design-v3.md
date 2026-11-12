# Vibe Guide 技术设计 v3

版本：v3.0 草案｜日期：2026-11-12｜配套：VibeGuide-PRD-v3.md

本文是拟实施方案，不表示已完成开发或运行验证。技术基线来自本机 `~/Documents/vg-4/VibeGuide` 源码检查；远端最新提交与当前桌面安装版本尚未核对。旧文档中的操作步骤视为历史设计依据，不自动构成执行授权。

## 1. 技术决策

沿用 TypeScript、React 侧栏、DSH 宿主服务、插件私有本地存储和现有构建方式。保留接入基础，围绕任务重新组织领域服务，不重写全部代码。

新增四个领域模块：Interview、Diagnosis、SideQuestion、Recap，共享 TaskContext 和 Evidence。主 Agent 仍在宿主中执行；插件的模型请求仅生成文本或结构化建议，没有业务工具执行能力。

默认转交方式为复制。草稿填入独立作为可选能力，接口验证通过后启用。新版 UI 不调用旧的直接发送 handoff 路径；不得仅更改按钮文案而保留发送行为。

## 2. 已有基础与复用边界

| 本地文件／模块 | 已观察到的实现 | v3 处理 |
|---|---|---|
| src/guide/plugin.ts | 注入 sessionQuery、sessionController、llm、网关等；监听 session/event、tools/execute、tools/result | 保留宿主接入，隔离为事件适配层 |
| src/guide/host/adapter.ts | 读取会话、项目及模型上下文 | 增加能力探测和任务证据适配；不假设新版本接口相同 |
| src/guide/progress.ts、store.ts | 操作记录及持久化基础 | 复用证据采集与存储机制，增加任务维度 |
| src/guide/trouble.ts、project.ts | 排障依据与分析基础 | 迁移至诊断服务，补聚合、自愈和建议过期处理 |
| src/client/index.tsx、rpc.ts | 右侧栏和 vibeGuide RPC 调用 | 重做三入口信息架构，沿用连接及错误封装 |
| src/guide/communication.ts、client/outbox.ts | 发送记录与持久化去重 | 旧记录只读保留；新转交使用 Copy/Draft 服务 |
| src/index.ts、prompts/core.md | 在 VibeGuide preset 注入沟通规则 | 保留兼容，但不依赖主 Agent 总能遵循提示词来判断事实 |
| host/compatibility.ts | 源码列出 rc.2、rc.3 为旧验证版本 | 作为历史兼容信息，当前版本重新实测 |
| scripts、tests | 构建、安装和隔离 smoke 基础 | 保留并增加新版场景；本轮未执行旧测试 |

当前工具跟踪部分依赖 agentPreset 为 vibeguide；不能声称标准模式中自动可用。首版沿用明确启用 VibeGuide 模式的路径，并在标准模式显示启用引导；如扩展为会话主动绑定，必须在宿主验证后再修改采集范围。

## 3. 逻辑架构与调用流程

```text
DSH 桌面 UI
  ├─ VibeGuide Sidebar：想清楚 / 陪我做 / 回顾
  └─ Selection Surface：解释 / 追问
               │ 经宿主认证的 RPC
VibeGuide Gateway：校验、任务归属、版本、请求去重
  ├─ InterviewService → TaskService
  ├─ DiagnosisService ← EventNormalizer ← DSH 会话/工具事件
  ├─ SideQuestionService
  ├─ RecapService
  └─ TransferService：复制内容 / 可选草稿填入
               │
ContextBuilder + ModelGateway + BudgetScheduler
               │
TaskStore / EvidenceStore / GeneratedArtifacts
```

ContextBuilder 负责按任务挑选证据、脱敏、截断和来源标记；ModelGateway 封装当前模型、超时、取消及结构化输出校验；BudgetScheduler 负责并发和用量约束。所有后台异常自行记录，不抛回主 Agent 的工具执行链。

## 4. 核心数据模型（建议契约）

以下是插件自有契约，不是已经存在的 DSH API。

```ts
type Task = {
  id: string; projectId?: string; title: string; revision: number;
  state: 'draft' | 'ready' | 'active' | 'review' | 'closed' | 'archived';
  brief: Brief; createdAt: string; updatedAt: string;
};
type BriefItem = {
  id: string; text: string;
  status: 'proposed' | 'confirmed' | 'deferred';
  sourceRefs: string[];
};
type Brief = {
  audience: BriefItem[]; goal: BriefItem[]; flow: BriefItem[];
  scope: BriefItem[]; exclusions: BriefItem[];
  acceptance: BriefItem[]; constraints: BriefItem[];
  openQuestions: BriefItem[];
};
type TaskBinding = {
  taskId: string; sessionId: string; startSeq: number;
  endSeq?: number; projectId?: string;
};
type Evidence = {
  id: string; taskId: string; sessionId: string;
  seq: number; eventId?: string; callId?: string;
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'host-state';
  observedAt: string; text: string; digest: string;
  origin: 'user' | 'agent' | 'tool' | 'host';
  completeness: 'full' | 'truncated' | 'partial';
};
type Issue = {
  id: string; taskId: string; revision: number; fingerprint: string;
  status: 'observed' | 'awaiting-recovery' | 'open' | 'resolved' | 'dismissed';
  certainty: 'observed' | 'suspected'; category: string;
  evidenceRefs: string[]; lastSeenAt: string;
  explanation?: string; nextStep?: string; transferText?: string;
  basis: string; stale: boolean;
};
type Recap = {
  id: string; taskId: string; taskRevision: number;
  through: Array<{ sessionId: string; seq: number }>;
  basis: string; trigger: 'manual' | 'candidate-delivery';
  sections: Array<{ title: string; text: string; evidenceRefs: string[] }>;
  verification: 'not-observed' | 'partial' | 'checks-observed' | 'user-confirmed';
  limitations: string[]; createdAt: string;
};
```

另存 InterviewTurn、SideThread、TransferArtifact、UsageLedger。所有生成物保存 taskRevision、basis、promptVersion、模型标识和来源；不保存密钥。用户确认单独由 UI 操作落盘，模型不得输出 confirmed 状态直接生效。

## 5. 任务归属与状态

访谈可在项目目录建立前创建 draft task。连接项目时显示绑定目标，经确认后关联；不根据目录名静默合并任务。项目键可沿用规范化真实目录的摘要，但路径摘要不等于匿名化。

同一会话只允许一个活动 TaskBinding。切换任务时关闭旧绑定的 seq 区间。未绑定时只显示当前会话的基础帮助，不自动把全部历史内容收为一个任务；可让用户选择“从这里开始”或确认导入的历史范围。

状态流：draft → ready（用户确认说明）→ active（用户绑定并开始）→ review（候选交付）→ closed（用户确认完成）。review 后继续开发回到 active。跳过访谈可直接创建 active，但 brief 标为缺失／待确认。一次对话停止不会触发 closed。

首版不自动跨会话续接；同项目多个任务隔离。未来续接通过显式绑定及多个 throughSeq 截止点扩展。

## 6. 宿主适配与能力探测

建议内部 HostCapabilities：observeSession、observeTools、sideModel、cancelSideModel、selectionSurface、composerDraft、deliverySignal。启动时通过轻量探测和版本检查建立能力表，缺失能力按功能降级，不仅凭版本号认定可用。

已在旧源码见到：sessionQuery.observeSession、会话及工具事件、Typert 网关、侧栏 slots 和 connection.rpc。需要验证：当前安装版本事件结构、授权上下文、草稿写入、选区宿主及原生菜单扩展、稳定的阶段结束信号。技术实现必须以当前 DSH 提供的接口为准，不把本文内部方法名当作宿主现成 API。

选区优先使用已公开的 slot 或可用插件能力。若只能监听 DOM，封装单独适配器，仅限定主消息区域，排除编辑器和插件自身 UI，处理多段选区、缩放、滚动、输入焦点和卸载清理。保存选区文本与消息来源快照，不能依赖弹窗打开后仍存在的浏览器选区。无法验证消息归属时拒绝自动附加上下文，允许手动粘贴。

## 7. 插件内部 RPC（拟新增）

沿用经过 owner 与 session 资源授权的网关；每个方法再次核对 taskId、sessionId 及绑定关系。requestId 用于请求去重，expectedRevision 用于并发写入保护。

| 方法 | 输入重点 | 输出 |
|---|---|---|
| task.create / task.bind / task.get | sessionId、taskId、绑定范围 | Task 与当前能力 |
| brief.answer / brief.revise / brief.confirm | 用户原话、expectedRevision | 更新任务卡与下一问 |
| transfer.prepare | 来源、目标、expectedRevision | 可见完整文本及摘要 |
| issue.list / issue.report / issue.dismiss | taskId、问题现象、expectedRevision | Issue 列表或更新 |
| side.ask / side.cancel | 选区快照、threadId、requestId | 答案与来源／取消状态 |
| recap.generate / recap.get | taskId、触发类型、basis | 回顾或已有缓存 |
| data.deleteTask / preferences.update | 对象及版本 | 删除／更新回执 |

复制在用户点击后由客户端调用可用剪贴板能力；失败保留文本并提供手动选择，不声称复制成功。草稿填入必须核对当前会话与非空草稿；默认不覆盖，用户明确选择追加或替换后执行。复制和填入都不得调用 session.prompt，也不返回“已发送”。

## 8. 访谈引擎

采用受约束的结构化模型输出：extractedItems、contradictions、nextQuestion、recommendation、readinessReasons。结构解析失败时保留输入，允许重试；不靠截取某个文本标记写入任务卡。

提问优先级按“是否阻断核心流程、是否影响验收、用户回答成本”排序。readiness 由程序检查最低字段和未解决矛盾，模型提供解释。第五轮起显示结束选项；用户可随时跳过。推荐方案落为 proposed，用户确认后升为 confirmed。

修改已有答案时提升 revision，对依赖该答案的下游项标记待复核。只生成建议，不自动删除用户确认的内容。交接文本按模板输出，未定事项独立列出；模板和提问 prompt 分版本。

grill-me 作为方法参考。实际复制其提示词或代码前记录准确仓库、提交和许可证；本阶段不引入未核对依赖。

## 9. 事件处理与诊断

### 9.1 采集

工具前后事件关联 callId；事件去重键包含会话及事件 ID／seq，优先使用稳定宿主 ID。截断保存大输出，保留原始结果摘要与 completeness。进程重启从持久化 cursor 补读，处理完再推进 cursor；使用幂等 upsert 避免重复计数。执行未完成时标记 pending，超时只标 unknown，不推定失败。

### 9.2 规则与模型分工

规则识别明确失败与等待状态；模型负责基于证据解释、提出检查或修复建议。错误分类优先宿主结构化状态及退出信息，不能只凭正文出现 error 字样判错。用户否定句、引用错误示例和测试预期失败需区分。

fingerprint 建议由 taskId、操作类别、归一化错误类别及目标摘要组成。归一化去掉时间戳等噪声，但保留会影响问题归属的资源／目标。以具体相关操作判断恢复，不能用一次无关成功清除全部问题。

首次失败进入 awaiting-recovery；10 秒后仍未恢复且没有相关修复进行时提示。相关修复进行中延后，两分钟后可显示安静状态。重复两次同类失败升级优先级。规则时长集中配置并使用可控时钟验证；不在主工具链等待计时器。

### 9.3 过期与异常

每个建议绑定 evidence basis。新相关证据出现时先撤销“当前有效”，异步判断 resolved／仍开放，再生成建议；避免用户复制旧修复。模型返回晚于新证据时存为历史而非覆盖当前卡片。模型不可用时展示事实与“请主 Agent 解释这次失败”等通用检查指令，不伪造根因。

## 10. 侧问上下文与模型调度

上下文优先顺序：用户问题及选区 → 任务卡 → 邻近消息 → 与问题相关的少量工具证据。首轮建议最多 20 条相关消息、选区 12,000 字符、总输入约 12,000 tokens；最终按模型上下文上限扣除输出及系统余量，截断时显式告知依据不完整。

来源统一使用不可变 evidenceRefs。会话内容、工具输出、附件和选区均按参考材料组织，不能提升为插件系统指令。侧问、诊断、回顾不挂载文件修改、命令或消息发送工具。

交互请求优先，自动请求低优先；插件侧最多一个模型请求在途。新用户请求可取消尚未开始的后台任务；取消能力未经宿主验证时仅停止接收并标记状态，不能声称服务端已经停止计费。

预算建议：每任务自动诊断最多 5 次、自动回顾 2 次；同 issue/basis 不重复调用；单次生成超时 90 秒；自动失败不无限重试。默认自动能力开启，但首次启用解释其模型用量，可分别关闭。额度为插件请求限制，无法保证与提供商账单精确一致。模型与主 Agent 共享账号时不承诺零资源竞争。

## 11. 回顾生成与可信性

首先构建事实包：任务版本、范围内的操作时间线、确认的文件改动、检查结果、交付自述、用户反馈、缺失数据。模型只将事实包改写为白话步骤，不从代码库猜测本任务做过什么。

候选触发需要 Agent 明确交付表达、当前无已知工具运行和审批等待，并有新证据；没有可靠宿主结束事件时在安静窗口复核后生成，属于候选阶段回顾。语义不确定时不自动触发。输出检查 evidenceRefs 真实存在；“通过”描述必须对应具体检查成功，“已上线”必须有相应发布证据。摘要不得据单次测试推断全部功能通过。

缓存键：taskId + taskRevision + 截止点 + evidenceDigest + promptVersion + model。生成后有新证据则标历史，保留原稿。自动回顾不把任务标 closed。缺失记录时 limitations 必须呈现，用户可手动补充但标为用户陈述。

## 12. 存储、迁移与隐私

优先沿用 GuideStore 的持久化机制，增加 schemaVersion 和独立 v3 数据命名空间。先审查现有原子写入、锁和恢复机制再决定是否替换，不为新增功能直接引入数据库依赖。

迁移采用读旧写新：备份旧插件记录，迁移解释、操作与用户偏好；旧 requirements、delivery 不自动转成已确认的新任务。旧发送中的记录保持只读，不恢复发送队列。迁移可重复执行且带版本标记；失败保留原数据并显示可恢复状态。回退旧版本不读取 v3 新结构。

任务删除覆盖证据副本、生成物、侧问、索引、缓存和待执行后台任务；正在生成的结果不得在删除后重新落盘。清理仅影响插件目录，不删除主会话或项目。明确标出仍保留迁移备份的位置及独立清理入口。

模型请求仅携带必要片段。复用并补强 privacy.ts 的脱敏；不保证正则能识别所有秘密。默认日志不记录全文；调试导出需用户主动操作并预览。错误信息不向客户端暴露密钥、任意文件内容或详细堆栈。

## 13. 安全、并发与降级

- 请求绑定 owner、session、task；不可仅相信前端传入的 projectId。
- 所有写操作进行 revision 比较，冲突要求刷新，不能静默覆盖。
- 插件生成内容用安全 Markdown 渲染；不允许原始可执行 HTML；外链显式打开。
- Tool hook 记录失败必须吞并为插件错误并继续原执行；插件工作排队与主 Agent 执行分离。
- 缺少工具事件时禁用自动工具诊断，保留文字解释；缺选区接口时手动粘贴；缺草稿接口时复制；模型故障时保留任务卡、规则事实和已有回顾。
- 卸载时释放监听器、计时器与选区 UI。停用不删除数据、不补发任何内容。

## 14. 测试与发布门槛

沿用现有 npm test 和隔离桌面 smoke；先在目标版本记录基线，再扩展以下有意义的场景：

1. 领域测试：访谈停止／矛盾、确认权限、任务绑定范围、证据去重、问题聚合和相关恢复、建议过期、回顾来源校验、迁移幂等。
2. 集成测试：真实宿主事件规范化、owner 与跨会话授权、模型取消／晚到结果、重启补读、存储失败不影响主工具链。
3. 桌面流程：新会话无目录访谈；跳过后开工；失败后自愈不扰民；重复失败一张卡；划词追问；切会话；复制失败；非空草稿保护；阶段回顾后继续开发；删除任务时生成中。
4. 模型评测：固定真实风格用例，评估提问有效性、解释准确性、错误根因是否过度断言、无证据完成声明。记录模型与 prompt 版本，真实调用单独运行并说明用量。
5. 真人试用：按 PRD 的简单任务和预设卡点评估；技术 smoke 通过不等同于产品可用。

发布门槛：目标 DSH 精确版本的安装／升级／停用验证通过；无自动发送；无跨任务混入；关键结论有证据；模型故障和缺接口可降级；完成至少一轮目标用户试用并修复阻断项。

## 15. 实施拆分与退出条件

| 阶段 | 工作 | 可检查的结果 |
|---|---|---|
| M0 能力验证 | 核对宿主版本、事件、选区、模型与草稿；记录旧测试基线 | 能力矩阵与最小集成验证，无未核实 API 承诺 |
| M1 任务与访谈 | TaskStore、绑定、访谈、任务卡、复制 | 用户可在无项目的新会话完成一次交接 |
| M2 陪我做 | 事件归一化、诊断状态、降噪、手动报问题 | 明确失败和反复失败可解释，自愈不重复提醒 |
| M3 划词与侧问 | 选区入口、上下文、独立历史、取消 | 不发主消息即可解释与连续追问 |
| M4 回顾与发布 | 事实包、自动候选触发、历史、迁移及用量 | 可追溯回顾、完整降级验证与用户试用 |

M0 若发现某能力不可用，应采用本文降级方案并更新 PRD 交付说明，不以私有接口猜测推进。本文交付仅包括文档，尚未修改旧插件、安装配置或运行真实模型评测。

## 16. 参考与证据级别

直接检查的依据：旧项目 package.json、README.md、src/index.ts、guide/plugin.ts、host/adapter.ts、host/compatibility.ts、contracts.ts、intent.ts、client/rpc.ts、client/outbox.ts，以及 2026-11-02 侧栏设计记录。

产品参考：[VibeGuide 仓库](https://github.com/wwyking123/VibeGuide)、[DSH 划词插件](https://github.com/suiyideali/dsh-selection-toolbar)。外部项目的接口、许可与版本必须在实际复用前再次核对。本文新增类型、方法、阈值和目录组织均为设计建议，不能作为宿主已支持的证据。
