# VibeGuide 参考项目与宿主调研

核实日期：2026-10-14。来源限官方项目仓库与其文档。本次是文档和部分源码调研，没有安装运行这些项目。当前交付仍是 HTML 概念原型，未实现真实插件；“可以借鉴/改编”不等于已经集成或通过兼容性测试。

已选技术路线：用户明确要求 VibeGuide 集成在 DeepSeek Harness 内，首发形态锁定为 Harness Web 插件。借鉴规格工具的验收结构及 Claude Mods 的交互方式，不再将宿主选择列为待批准事项。真实安装成本和原题回答仍是实现与发布前的验证门槛。用户痛点证据另见[USER_RESEARCH.md](USER_RESEARCH.md)，最新交互与优先级见[INTERACTION_DESIGN.md](INTERACTION_DESIGN.md)。第一版不需要同时集成多个规格框架或自建完整编码Agent；代码地图延后。

## 1. 哪些 GitHub 项目最值得看

| 项目 | 借鉴机制 | 在 VibeGuide 中的用途 | 复用判断 |
|---|---|---|---|
| [GitHub Spec Kit](https://github.com/github/spec-kit) | 用户旅程、独立测试、Given/When/Then 验收场景、待澄清项 | 新手描述目标后，生成可观察的成功条件 | 可改编模板；不把整套工程流程暴露给新手 |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | 一次变更连接 proposal、specs、design、tasks，并归档 | 让已有项目的改动有目标、决定、实现和验收记录 | 借鉴变更生命周期；首版不引入完整 CLI 依赖 |
| [Aider](https://github.com/Aider-AI/aider) | 代码符号与依赖索引、按相关性和 token 预算取上下文 | 点击业务节点后找到有关文件，再解释影响 | 借鉴算法与源码；Python 模块不能直接当作 TypeScript 插件接入 |
| [DeepWiki-Open](https://github.com/AsyncFuncAI/deepwiki-open) | 从仓库生成可浏览说明、结构图与代码导览 | 从整体业务地图逐层展开到代码依据 | 主要参考信息组织与生成流程，不作为首版运行依赖 |
| [Claude Code Playground](https://github.com/anthropics/claude-code-playground) | Blast Radius 的执行前影响提示、Replay Theater 的逐步编辑回放 | 决策卡、变化时间线和原生 Mods 交互 | 可改编示例；必须重新定义执行成功与证据语义 |
| [Techie](https://github.com/dhpwd/techie) | 面向非技术者的Claude Code插件；概念解释、初次引导及保存/历史命令 | 参考就地解释、明确下一步和减轻入门负担 | 已核对README，未安装或验证行为；不能据其宣传保证记忆或恢复效果 |

### Spec Kit 与 OpenSpec

Spec Kit 的[规格模板](https://github.com/github/spec-kit/blob/main/templates/spec-template.md)把用户场景和验收条件放在中心。适合将复杂表格藏在引导流程背后，用户只回答“谁用、做什么、怎样算完成”。[MIT 许可证](https://github.com/github/spec-kit/blob/main/LICENSE)

OpenSpec 的[官方流程](https://github.com/Fission-AI/OpenSpec#readme)围绕一次变更逐步建立提案、规格和任务，并在归档时更新规格。适合项目已经存在之后的增量修改。[MIT 许可证](https://github.com/Fission-AI/OpenSpec/blob/main/LICENSE)

设计判断：取两者的字段与生命周期，定义一份最小 Task/Decision/Verification 契约即可。用户不需要面对两套规范目录。任务勾选、规格归档和验收通过是三个独立事实。

### Aider

[Repo Map 文档](https://aider.chat/docs/repomap.html)说明了通过符号、调用签名和依赖排名，在有限上下文内提供相关代码；[repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)可作实现参考。[Apache-2.0 许可证](https://github.com/Aider-AI/aider/blob/main/LICENSE.txt)

设计判断：VibeGuide 应优先采集与用户问题有关的事实，再生成解释。Repo Map 服务于模型理解代码，不直接提供业务概念，也不证明运行时行为。第一版只做受支持技术栈的轻量索引；规模变大后再评估图排名和更复杂解析器。

### DeepWiki-Open

[官方 README](https://github.com/AsyncFuncAI/deepwiki-open#readme)介绍了代码分析、文档和可视化导览。截至本次调研，main README 已转向 DeepWiki-Open 2.0 / Grok Wiki 下载；仓库仍有源码目录，但本次未验证构建和运行完整性。[MIT 许可证](https://github.com/AsyncFuncAI/deepwiki-open/blob/main/LICENSE)

设计判断：借鉴“概览 → 模块 → 依据”的层次，首屏改用页面、数据和规则等用户概念。生成完整 Wiki 不解决当前这次改动的决策和验收，因此不把自动生成文档作为核心交付。

### Anthropic Mods 示例

[Blast Radius](https://github.com/anthropics/claude-code-playground/blob/main/claude-code/mods/blast-radius/README.md)展示部分危险 Bash 命令的影响预览；[Replay Theater](https://github.com/anthropics/claude-code-playground/blob/main/claude-code/mods/replay-theater/README.md)展示编辑回放。Playground 明确是实验示例，不是受支持产品。[Apache-2.0 许可证](https://github.com/anthropics/claude-code-playground/blob/main/LICENSE)

重要实现区别：Replay 示例在工具调用时记录信息，因此一次出现在回放中的编辑未必成功。VibeGuide 的“实际改动”必须关联最终执行结果及应用后的差异。危险命令匹配只能覆盖特定模式，不能当作完整权限控制。

## 2. DeepSeek Harness 能否承载它

[官方仓库](https://github.com/deepseek-ai/deepseek-harness)仍标注 developer preview。调研读取的源码快照为 `d743267388641bc76f17c45ce8b4c231aed1d32c`，根包版本为 `0.2.1-alpha.2`，见[对应 package.json](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/package.json)。这只是调研锚点，不代表已验证的安装版本。

| 能力 | 官方接口/机制 | VibeGuide 用法与边界 |
|---|---|---|
| 插件注册与依赖 | Cordis `apply(ctx)`、`inject`，bundle 的 `dsh.bundle.patch` 指向 Loader patch | 独立插件，不 fork 宿主；先在独立 profile 中验证安装 |
| 客户端入口 | `dsh.client` 与 `./client` 导出；客户端半部随 Loader 行加载 | 需要符合宿主的 lazy-CJS factory 打包形式；普通 npm 前端包不足以证明可用 |
| Web 侧栏 | `ctx.sidebarRightTabs.register`、`ctx.slots.register`、`ctx.sidebarRight.openTab` | 支持原生面板；以 session 为单位组织 |
| 事件观察 | `session/event` 的持久事件；另有实时 assistant stream | 持久事件用于回放，实时流只表示进度 |
| 文件与差异 | `ctx.fs`；内置 `write`/`edit` 结果的 diff 元数据 | 优先支持这些工具的实际结果；不能假设涵盖 Bash、MCP 和外部编辑器 |
| 模型调用 | `ctx.llm.stream` 使用已配置 provider/model | 不必另收密钥；当前会话模型继承、费用归属和显示仍需实测 |
| 执行前控制 | `tools/pre-execute`、approval；最终结果可从 `tools/result` 观察 | 可验证特定工具的提示机制；MVP 先做观察，不改写结果或自动授权 |
| 任务交回宿主 | 扩展 cookbook 提供 agent followup/steer 等入口 | 侧栏选择到任务提交、执行因果关联需实测；不能仅凭接口存在就声称闭环成立 |

上表来源分别是：[启动与 bundle](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/boot/app-boot/README.md)、[客户端半部说明](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/cookbook/adding-a-settings-card.md)、[侧栏扩展协议](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-sidebar-right/README.md)、[事件架构](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/architecture.md)、[文件工具](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/fs/tool-fs/README.md)、[LLM 服务](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/llm/llm/README.md)、[扩展 cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/cookbook/extension-cookbook.md)。

最大近期风险是第三方客户端 bundle 的构建：调研中的 `clientBundle` preset 尚不是可直接依赖的已发布构建包。应先做极小侧栏，确认构建、安装、事件、重连及卸载，再承诺完整产品。未确认打包成功前，不应把“官方有侧栏”写成“插件已可直接发布”。

### 原生布局与概念原型边界

固定提交 `d743267388641bc76f17c45ce8b4c231aed1d32c` 的官方源码说明证实：左栏是 Harness 品牌、新建会话、Workspace／Session 导航及设置；中栏保留原对话，顶部承载会话标题、操作与视图切换，底部是 composer。原生用户问题临时占据 composer，而不是独立的右侧问题收件箱。[左栏](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-sidebar/README.md)、[对话结构](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-conversation/README.md)、[原生问题卡](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-user-questions/README.md)

右侧按会话组织的 tabs 提供 `ctx.sidebarRightTabs.register`、`sidebar.right.pane.tab` 与 `ctx.sidebarRight.openTab`。概念原型因此保留上述宿主外壳，在右侧新增按需打开的「VibeGuide」tab；其内容解释当前原题与方案，不另造主聊天。[右侧栏协议](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-sidebar-right/README.md)

`conversation.chat.node`、`conversation.chat.assistant-actions` 和 `tool.call.toolview` 是已声明的消息／工具呈现扩展点，但各自有所有权、基数与作用域约束，不能推断任意消息旁都能追加组件。“看懂这一步”入口的位置，以及右栏与原题草稿的同步、提交和取消联动，仍是设计假设，须在固定版本实测；HTML 中的模拟联动不证明真实接入。[Slot 约束与层级](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/subsystems/slots.md)

## 3. Claude Mods 能否承载它

[官方概览](https://code.claude.com/docs/en/plugins/mods/overview)确认 Mods 是在 Claude Code 内运行的 JS/TS 插件事件处理器。可观察或改变事件、添加命令、渲染面板，适合以后实现 VibeGuide 的第二个宿主。

| 需求 | 已核实能力 | 不能直接推断的事项 |
|---|---|---|
| 自定义面板 | `ui.render`、`$.ui.open` 及宿主 UI 元素 | 不能把浏览器 React 组件原样搬到终端 |
| 执行前后处理 | 工具调用、会话及回合事件 | 不同事件阶段不等同于成功执行 |
| 模型、存储与文件 | 经 mods API 提供模型调用、存储和文件访问 | 模型调用会使用账户额度；不默认无成本 |
| 显示覆盖面 | 终端和 Desktop Code 界面显示 Mods UI | VS Code 聊天面板、headless 和云会话不能假设显示同样面板 |
| 权限提示 | Mod 可有自身交互 | 官方权限提示不能被替换；VibeGuide 不应自动批准工具 |

来源：[UI 文档](https://code.claude.com/docs/en/plugins/mods/interface)、[事件文档](https://code.claude.com/docs/en/plugins/mods/events)、[模型与其他 API](https://code.claude.com/docs/en/plugins/mods/api)、[运行界面与信任边界](https://code.claude.com/docs/en/plugins/mods/overview#where-mods-run)。Mods 属于高权限本地代码，不是隔离沙箱。[官方内置 Mods 源码](https://github.com/anthropics/claude-code/tree/main/mods)还可用来理解 diff、类型契约和测试方式。

kiro 的独立官方文档审查还指出：部分服务器侧工具不触发客户端的工具事件；没有证实覆盖全部事件的统一因果 ID。事件缺失不能解释为操作未发生。运行结果也可能受其他 Mods 改写，因此 VibeGuide 提供的是开发辅助证据，不是防篡改审计。适配时应以目标安装版本生成的类型为准。[事件与关联字段参考](https://code.claude.com/docs/en/plugins/mods/reference)

## 4. 调研带来的设计决定

1. 第一版固定集成 DeepSeek Harness Web；Claude Mods 仅保留为交互参考及后续适配候选，避免双份 UI 与生命周期拖慢验证。
2. 用业务任务组织上下文，地图按需展开；不把全部依赖关系直接画给新手。
3. 规格、工具调用、工具成功、行为验收分别存储。语言模型负责说明，程序负责状态与证据约束。
4. 用户操作记录连接到实际结果；项目变化后更新地图、使旧验证失效。
5. 开始时借鉴模板和机制，不把 Spec Kit、OpenSpec、Aider、DeepWiki 全部变成运行依赖。

尚未验证：宿主真实安装与性能、第三方 bundle 全流程、现有用户迁移成本、解释模型质量及真实支付意愿。以上不影响提出产品方案，但决定实施顺序和承诺范围。

## 5. 用户补充痛点后的原生提问核实

用户明确指出技术性提问和方案确认使自己难以理解，盲选会偏离需求。首个技术验证因此改为提问解释及原题回答，再连接改动证据。

DeepSeek 提供 `user-questions/request` 问答通道；`question.id` 只要求在同次调用内唯一。选项没有独立 ID，答案使用原始 `label`。`custom` 支持自由文本，单选时替代既有选项；`plan-review` 可标识方案确认。显示译文与回传字段必须分开。[官方问答类型](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/user-questions/src/types.ts)

等待中的问题由原请求返回答案；timed 调用返回 pending 后有按 callId 路由的 answer 方法。普通 followup/steer 不等同回答原题，需求回答也不等同工具权限 approval。[问答生命周期](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/user-questions/README.md)

默认 ask_user_question 使用阻塞 legacy，不具备与 timed 相同的迟答恢复。先验证显式 timed、timeout=-1，再单独验证默认 legacy；任何超时都不代表用户批准。[工具模式说明](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/interaction/tool-ask-user/README.md)

尚未运行验证：第三方客户端怎样无冲突地增强既有问题 UI；legacy 下调用身份如何取得；重复 label 如何消歧；批量问题如何完整回传。重复标签无法区分时不得自动映射，应提示宿主澄清。普通聊天提问先以用户主动选中或粘贴启动辅助。Codex 的原生问题 UI 扩展接口本轮未核实，保留为候选适配，不能宣称现已支持。

## 6. 本轮用户研究带来的技术约束

官方仓库历史报告中出现过问题前上下文丢失、逐题回退粒度缺失、嵌套权限不可见和安装依赖失败；每项来源、版本与修复状态见[用户调研第6节](USER_RESEARCH.md#6-宿主原始问题报告)。它们不是非技术用户发生率证据，也不是当前所有版本的缺陷清单。

因此接入验证须包含：缺失上下文的诚实降级、原生/插件回答去重、可见等待状态、明确恢复边界和干净环境安装。插件不修补宿主已经解决的历史问题，不将来源缺失写成“没有风险”。完整系统地图降到P1后，P0只扫描当前目标所需上下文与证据。
