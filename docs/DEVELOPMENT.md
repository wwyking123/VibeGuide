# VibeGuide 开发说明

更新：2026-10-21。版本：0.2.0-alpha.1。白话规则版本：2026-10-21.2。

## 六项开发能力（0.2.0-alpha.1）

用户排除代码撤回，要求完成其余六项。新增 `src/workbench/`，接入唯一 VibeGuide 模式，新增两个工具（连同原项目工具共三项），复用宿主工具执行和权限。新记录独立于旧 project.json，安装不迁移或重写旧要求。能力、数据位置、容量与边界见 [WORKBENCH.md](WORKBENCH.md)。

已完成真实宿主的原生 bash 结果回执、检查失效、共识/偏好跨进程读取，以及受控服务响应与来源边界验证。Agy 负责只读产品误解审查，Kiro 负责只读兼容和记录边界审查；核心代码由主 Agent 完成，另有辅助 Agent 核实宿主接口并审查删除链与偏好作用域。没有实际接入用户的远程 Supabase 服务，不把受控响应或本地模板当成真实上线。

最终验证：41 项自动测试通过，13 项场景结构校验和冻结样例检查通过；真实宿主完成双进程重开、三个新增工具的 Schema/SDK、原生 bash 回执、证据失效及个人偏好与项目资料隔离。审查发现的关联摘要残留、来源标记丢失、项目限定偏好、同会话停用状态丢失、过时事实、游标改写和失效任务选择均已修复。

已升级日常 `~/.dsh` 安装到 `0.2.0-alpha.1`，仍只声明一个 VibeGuide。配置有原始备份；既有 1 份记录的安装前后摘要一致，其他配置保留。安装副本 27 个构建/提示文件逐字节一致，并通过真实宿主加载检查。用户需完全退出 Harness 再打开，新建 VibeGuide 会话加载新能力；未修改旧聊天或既有 A/B 环境。

## 关键需求先澄清与单一模式（alpha.4）

真实试用反馈：只提出“21 天打卡思考小游戏”的方向，两个模式都直接开始开发。旧规则强调低风险操作直接推进，却未明确区分产品想法和可执行需求。现补充：关键玩法/使用范围尚不清楚时先问少数业务问题并等待，回答足够后继续；完整明确需求、局部小修改和明确委托原型不做机械访谈。新增三条正反案例，共 13 条。

桌面版统一为 `vibeguide`，保留项目记录能力。安装器 `--upgrade` 以新插件副本替换两个旧声明，原配置备份，旧插件与聊天文件不删，沿用原记录路径。宿主不支持迁移非空 P0 会话，因此旧 P0 聊天不能原地恢复，新 VibeGuide 会话在同项目读取保存点；不改历史 header。既有对照环境保持冻结。

29 项自动测试及真实桌面全新安装、双模式合并、原生工具保留和进程重开测试通过。模型响应检查使用独立的 `scripts/eval-kickoff.mjs --live`，每例最多三次调用，只执行隔离记录工具和允许的只读检查，不执行生成的项目修改；完整用户理解验收仍待完成。

2026-10-21 的真实模型抽样（DeepSeek Flash，high）使用用户的 21 天小游戏原句：模型先询问每日打卡动作、问题来源、第一版使用范围；提供受控的“问题待回答”结果后，模型明确等待，没有尝试写业务代码。此结果验证一次抽样中的提问和等待行为，不代表原生提问界面或完整开发流程验收。另两例完整需求、委托原型在读取环境时达到评测允许范围边界，执行结果未定；小修改例生成了修改意图但未执行，还额外调整了字体颜色，不能记为完整通过。问题选项中“多人使用需要数据服务”“随机题目不保证不重复”等后果表述也过于绝对，解释准确性仍需后续评测。

日常桌面安装已升级至 alpha.4：配置只声明一个 VibeGuide，安装副本与构建产物一致，已存在的项目记录逐字节保持不变；真实宿主成功加载已安装副本。需要完全退出并重开 Harness 后，在新 VibeGuide 会话中试用。

## P0 项目续接（alpha.3）

依据最新产品设计新增独立 `vibeguide-p0` 桌面预设。实现项目要求及来源、纠正/删除、任务进度、本地持久写入、版本冲突和相关文件变化检查。继续复用宿主模型、原生对话和全部 31 项工具，只增加一个本地记录工具。普通预设与原版 VibeGuide 均不加载新增状态。

入口为 `src/continuity/plugin.ts`，记录逻辑为 `store.ts`，原生用户来源校验为 `sources.ts`。动态上下文只使用异步 assembly hook，避免宿主 admission refresh 用同名静态 provider 覆盖已读取状态。使用会话原始项目路径，来源消息 ID 由宿主赋值；本地版本写入确认后才返回保存成功。

新增 `npm run smoke:continuity`、`npm run check:continuity` 与 `install-desktop.mjs --continuity`。26 项自动测试通过；真实 `0.2.1-rc.2` 宿主在临时数据目录完成独立安装、进程退出/重开、纠正、原生选择来源、Schema/SDK、隔离及损坏降级检查。保存失败/未知使用受控存储测试，未调用模型。具体契约、限制和命令见 [CONTINUITY.md](CONTINUITY.md)。

下一步是按 [连续任务材料](../evals/continuity/README.md)进行真实对话和用户理解试用；未取得的模型行为、用户观察、时延/用量结果不记为通过。没有修改日常 Harness 安装或现有 A/B 项目。

本轮主 Agent 负责实现、安装器、存储测试、宿主集成验证和文档；两个辅助 Agent 分别负责冻结试用材料及来源测试、只读宿主接口核实与审查，写入范围不重叠。下文保留 alpha.2 / rc.6 的历史接入记录；其中“没有任务记录”仅描述当时的原版白话预设。

## 桌面版安装适配（alpha.2）

安装时发现正在运行的桌面版为 `0.2.1-rc.2`，与 `/opt/homebrew/bin/dsh` 的 `0.1.0-rc.6` 不同。桌面版使用 `dsh-agent-preset` 声明和 `dsh-agent-preset-registry`，不再扫描旧 `.agent-presets` 目录。

新增 `scripts/desktop.mjs`、`install-desktop.mjs`、`smoke-desktop.mjs`。直接使用桌面版 Electron 的 Node 模式读取并加载安装包中的真实宿主模块；不启动第二个桌面窗口。安装器复制新版标准预设声明，保留全部子插件，通过独立 Include 将 VibeGuide 注册到 desktop profile。为避免 profile 外部目录的包查找差异，声明中的宿主模块引用指向当前桌面版自带模块的文件 URL。

写入前验证原配置语义不变并备份原始字节；只新增 VibeGuide 声明，不改变模型和默认预设。需要重启桌面版生效。若卸载，先关闭 Harness，从 profile patch 移除 `id: vibeguide-presets` 的插入项，再移走对应插件目录；原始备份用于核对，不应覆盖安装后新增的其他设置。

已通过真实桌面版隔离环境测试：预设可发现、创建真实 Agent、31 项标准工具定义一致、原生提问可用、普通会话隔离，且浏览器打开次数为 0。未调用模型。下文的 25 项工具与目录型 preset 描述仅适用于旧 CLI 接入。

## alpha.2 历史实现范围

完成生成前规则注入与本机宿主集成这一最小可运行切片。没有新增前端、第二模型、输出翻译、全局会话拦截或持久化任务记录。

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 原生 Cordis 插件，注册独立提示 section |
| `prompts/core.md` | 沟通规则，2060 个 Unicode 字符、5916 字节 |
| `scripts/install-preset.mjs` | 复制 standard、打包本地插件、创建新 preset |
| `scripts/harness.mjs` | 校验本机宿主版本，按其安装位置解析模块 |
| `scripts/smoke-harness.mjs` | 最小宿主加载、提示渲染、作用域隔离检查 |
| `scripts/smoke-standard.mjs` | 完整配置挂载、工具一致性与真实 Agent 检查 |
| `tests/` | Cordis 生命周期与安装边界测试 |
| `evals/` | 十个场景与人工对照评审方法 |

## 兼容基准

本机实际代码是 `@deepseek-ai/dsh@0.1.0-rc.6`。此前设计文档引用的 GitHub 固定提交是研究来源，不代替这个兼容基准。

本版使用复数包 `@deepseek-ai/dsh-agent-presets`，预设是包含 `agent.cordis.yml` 的目录，没有 `extends: standard` 语法。`ctx.systemPrompt.section` 支持 `{ name, order, text, complete? }`；本版不使用 `complete`，也不使用该版本不存在的 `interpolate: false`。

编译用宿主依赖只在 `devDependencies`，传递依赖用 `overrides` 锁到相同 rc.6 基准。发布 JS 除 Node.js 内置模块外没有运行时第三方依赖；声明文件使用本地结构类型，同时在编译时校验与真实 Context 的兼容性。安装器使用 POSIX 目录发布语义，面向 macOS/Linux，Windows 明确拒绝；Linux 尚未实测。

## 规则如何生效

1. 安装器复制 standard 目录，保留原始 YAML、`!!js` 表达式和附属资源。
2. 复制插件与规则到 `.vibeguide-plugin/`，追加相对路径插件行。
3. Harness 将预设挂载到独立 standing scope；新 Agent 在工厂 `setup(agentCtx)` 中加入。
4. 插件直接调用 `ctx.systemPrompt.section()`，注册 `vibeguide:communication`，顺序 300。原有身份、工具指导、运行上下文和权限机制保留。
5. 每次宿主组装提示都能读取该规则；Cordis 卸载插件时注销它。

必须直接通过 `ctx.systemPrompt.section()` 调用，不能解构后丢失服务调用上下文。`dsh-scope` 使用模块私有 Symbol，导入第二份运行时依赖可能造成 scope 身份不一致。因此插件只导入宿主类型，scope 处理交给真实宿主服务。

规则文件不拼接用户内容，不能包含 Harness 的双花括号变量引用，入口会检查。没有用户输入升级为系统规则的路径。将来若加入动态任务事实，需另行设计来源、插值、会话隔离和恢复。

本版依赖正确的 preset 安装位置，没有运行时“全局挂载阻止器”。手工挂到全局会影响所有 Agent，属于不支持的配置。

## 安装与生命周期

```text
<DSH_HOME>/.agent-presets/vibeguide/
  agent.cordis.yml              # standard 原文 + 插件配置
  preset.yml                   # 显示名称
  .vibeguide.json               # 版本、安装时间、配置与规则摘要
  .vibeguide-plugin/
    package.json               # ESM 标记，无运行时依赖
    dist/index.js
    dist/index.d.ts
    prompts/core.md
```

安装器先在不参与发现的隐藏临时目录准备完整副本，再排他创建目标目录并重命名发布。已有目录（包括空目录）不覆盖，失败只清理本次创建的内容。目标目录仅当前用户可访问。不修改 standard、宿主 profile、默认预设、模型设置或密钥。

自带预设名会被拒绝，避免被 system root 的同名预设遮蔽。若另有自定义 system roots，需选择不冲突的 ID；安装器不读取个人 profile。

standing preset 在进程内共享静态插件实例，不保存模块级用户状态。关闭一个会话不卸载共享预设。rc.6 的 generation 检测依赖 composition 文件，单改插件 JS 不保证热更新；开发时使用新 ID 并重启宿主。

## 已运行的验证

2026-10-18，macOS、Node.js 24.15.0：

| 检查 | 结果与范围 |
| --- | --- |
| TypeScript 构建 | 通过 |
| `npm test` | 两项测试通过：规则继承、重复组装、隔离、卸载/重载、关闭会话；完整复制、拒绝覆盖、路径 ID、自带预设重名 |
| `npm run check:evals` | 十个案例结构通过，不是语义评分 |
| `npm run smoke:harness` | 真实 rc.6 Loader 加载相对路径插件、Agent scope 加入、普通 preset/global 隔离、提示渲染 |
| `npm run smoke:standard` | 真实基础服务、standard/VibeGuide 同时挂载；25 个工具 schema 逐项相同；原有提示保留；真实 Agent 创建/销毁，原生 `ask_user_question` 可用 |

smoke 使用临时 `DSH_HOME` 并清理。完整检查使用官方 base 及 Web 的 host/agent 分离配置，但排除服务器、启动器和 UI 插件；未调用模型，遥测关闭。临时模块链接复现 CLI 的模块查找方式，没有复制第二份宿主依赖。

这些检查不包括页面操作、模型效果和真实长对话；重复组装提示不等于验证了压缩后需求不会丢失。规则文件大小不是 token 用量。

## alpha.2 当时的后续计划（已由最新 P0 计划替代）

1. 在真实会话中验证公司官网从零开发、已有报名工具修改，检查问题是否直接可懂、重要要求是否保留。
2. 同模型比较原生、普通白话提示、VibeGuide，保存全部输出、失败、追问次数、用量与耗时，按评审量表盲审。
3. 单独验证压缩、恢复、目标变化与多 Agent 场景，再判断是否需要额外任务记录。
4. 若简单提示效果相同，缩减规则；若主要失败来自上下文遗失，再实现可追溯摘要。

## 协作边界

主代理负责规则、全部插件/安装/测试代码、依赖、打包和文档。agy 只写评测案例和量表，交付后由主代理统一修订；kiro 只读核对 API 并审查实现。没有两个 Agent 同时修改核心文件。
