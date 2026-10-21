# VibeGuide

**Make technical systems legible to non-technical people.**

让 DeepSeek Harness 中同一个开发 AI 直接说清楚：准备做什么、需要你决定什么、实际做到了什么。用户继续使用原来的对话与提问界面。

当前版本：**0.2.0-alpha.1，开发验证版**。macOS Harness 桌面版 `0.2.1-rc.2` 统一使用 **VibeGuide** 模式，包含白话沟通、需求澄清、项目续接及下述六项开发能力。旧 CLI `0.1.0-rc.6` 仍只提供沟通规则。完整模型对照评测与用户理解验收尚未完成。

## 已实现

- 生成回答前加入持续沟通规则，覆盖方案、可行性、业务选择、开发进展、失败和完成说明。
- 安装为独立的 **VibeGuide 会话预设**，完整复制本机 Harness 标准开发配置，再添加插件。
- 使用宿主原有模型、标准工具和原生提问；已验证桌面版 31 项、旧 CLI 25 项工具完整保留。插件自身不发模型请求，不需要额外 API key。
- 只有笼统产品想法时，先问 2–3 个影响使用流程和规则的关键问题，等待回答后再写代码；明确需求、小修改或明确委托原型时继续推进。
- VibeGuide 在本机保存项目要求、来源、纠正和分开的任务进度；新会话在同一项目中可以读取。保留原有工具，额外增加三个项目与偏好工具；普通模式不加载这些能力。
- 写入检查版本、保存后读回核对；保存失败、结果未知、并发冲突分别返回。删除记录不改代码，文件变化提示不等于自动回滚。
- 项目共识、结构化验收记录与失效提示、静态改动影响与回归建议、Supabase 接入指南、跨会话个人偏好、任务相关分页和归档。具体用法和范围见[六项功能说明](docs/WORKBENCH.md)。
- 13 个中文场景及中性的三组对照评审标准。

例如，规则要求把“选 CMS 还是静态生成？”转为“同事编辑后直接对客户展示，还是先由你看过再发布？”。这是预期行为示例，尚不是实测模型输出。

## 开发与检查

需要 Node.js ≥ 22.18。旧 CLI 安装器面向 macOS/Linux（Linux 尚未实测），桌面版安装器面向 macOS。已验证 CLI `0.1.0-rc.6`（Node.js 24.15.0）与桌面版 `0.2.1-rc.2`（内置 Node.js 24.21.0）。暂不支持其他宿主版本或 Windows。

获取源码并检查：

```sh
git clone https://github.com/wwyking123/VibeGuide.git
cd VibeGuide
npm ci
npm test
npm run check:evals
npm run check:continuity
```

安装了兼容的旧 CLI 时，还可以运行：

```sh
npm run smoke:harness
npm run smoke:standard
```

两个 smoke 命令从本机 `dsh` 安装目录加载真实宿主代码，使用临时数据目录，不调用模型、启动浏览器或服务器，也不修改日常 Harness 配置。完整检查确认 25 项工具定义完全一致，并成功创建和销毁真实 Agent。

若无法自动找到宿主，可设置 `VIBEGUIDE_HARNESS_ROOT` 为 `@deepseek-ai/dsh` 的实际安装目录。

## 安装到 Harness

### 当前 macOS 桌面版

适用于 `/Applications/DeepSeek Harness.app`，宿主版本 `0.2.1-rc.2`。在源码目录运行：

```sh
npm run build
node scripts/install-desktop.mjs --home "$HOME/.dsh"
```

安装器将插件保存到数据目录的 `plugins/` 下，在 `profiles/desktop/cordis.patch.yml` 中增加预设声明，并把原文件原样备份到 `.vibeguide-backups/`。不会更改已有模型设置或默认预设。

**完全退出并重新打开 Harness，创建新会话，点击输入框上方、工作区名称右侧的「标准模式 ▾」，选择 VibeGuide，再发送需求。** 已开始的旧会话保持原配置。新版桌面版不读取旧 CLI 的 `.agent-presets/` 目录，不能混用两种安装方式。

`npm run smoke:desktop` 会在临时数据目录启动本机桌面版的真实宿主，验证完整安装、31 项标准工具、会话隔离和原生提问，然后关闭临时服务。不会调用模型或打开浏览器。

### 更新已有安装与合并旧模式

已安装 VibeGuide 或旧 P0 模式时，执行：

```sh
npm run build
node scripts/install-desktop.mjs --home "$HOME/.dsh" --upgrade
```

重启 Harness，在新会话的模式菜单选择 **VibeGuide**。更新会备份配置、准备新插件副本，再把原来的两个入口合并为一个；项目记录沿用原位置，旧插件副本和历史聊天文件保留。日常直接说“你记住了哪些要求”“继续上次的报名项目”等即可。

宿主不支持把已经开始的 P0 聊天原地切换预设：合并后请在**同一个工作区新建 VibeGuide 会话**，读取最近成功保存的项目记录。旧聊天不会自动导入，新模式也不能保证恢复尚未保存的内容。旧 `--continuity` 参数仅为脚本兼容保留，不再创建第二模式。

`npm run smoke:continuity` 在两个先后启动的独立测试进程中验证保存、重开、纠正、原生选项来源和项目隔离，不调用模型。它验证宿主接口与记录机制；真实 AI 是否正确提炼要求、及时保存和解释清楚，仍需按[连续任务试用材料](evals/continuity/README.md)亲自体验。记录位置、限制和异常处理见 [P0 开发与试用说明](docs/CONTINUITY.md)。

### 旧 CLI 版本

先生成一个仅用于开发的预设副本：

```sh
npm run prepare:harness
```

输出位于 `artifacts/dsh-home/.agent-presets/vibeguide/`，包含完整预设与独立插件。这个步骤不会启用到日常会话。重复执行会拒绝覆盖已有目录。

准备在日常 Harness 中试用时，在源码目录运行下面的命令。`--home` 必须对应 Harness 使用的数据目录，默认是 `~/.dsh`；自定义过 `DSH_HOME` 则替换为自定义目录。

```sh
npm run build
node scripts/install-preset.mjs --home "$HOME/.dsh"
```

随后使用 Harness Web 界面的预设选择功能，选择 **VibeGuide** 创建新会话，沿用宿主已有模型设置。已打开的界面可能需要刷新；本次未进行浏览器端验证。不要把插件加入全局 `cordis.patch.yml`，否则会影响所有会话。

rc.6 的 headless 模式没有 `--preset` 参数，也不会挂载此预设；本版不提供 headless 入口。现有会话即时切换不在本版范围内。

### 更新、停用与打包

- 停用：新会话选择「标准模式」。不要删除仍需恢复的旧会话依赖的预设。
- 桌面版更新：使用 `--upgrade`。未带此参数的重复安装会拒绝覆盖。插件不会自动跟随源码或宿主升级。
- 桌面版移除：先关闭 Harness，从 `profiles/desktop/cordis.patch.yml` 移除 `id: vibeguide-presets` 对应的插入项，再移走该项引用的插件目录。备份用于核对，不应直接覆盖安装后新增的其他设置。
- 已有项目记录保留在 `<DSH_HOME>/vibeguide-p0-state/`（兼容旧路径），停用模式不删除它们。
- 旧 CLI 更新：使用新 ID 安装，例如 `--id vibeguide-next`，重启 Harness 后创建新会话。安装器拒绝覆盖已有目录和宿主自带预设名。
- 旧 CLI 移除：停止 Harness 后，将 `.agent-presets/vibeguide` 文件夹移到预设目录之外保存；移回原处即可恢复。若曾设为默认，先在宿主改回 standard。
- 打包：`mkdir -p artifacts && npm pack --pack-destination artifacts`。生成本地安装包，不发布到 npm。解压后的包自带 `dist/`，可直接运行对应宿主的安装脚本。

## 当前边界

### 亲自进行对话对照

macOS 桌面版 `0.2.1-rc.2`、已登录 DeepSeek 账户时，可创建两个独立的 Harness Web 试用环境：

```sh
npm run build
node scripts/manual-compare.mjs prepare
node scripts/manual-compare.mjs start --directory <prepare 输出的目录>
```

打开 start 输出的 A、B 链接，按[手动评测步骤](evals/MANUAL_COMPARISON.md)分别对话。A 为默认模式，B 为 VibeGuide；两个空项目使用相同模型设置。准备器只复制模型设置和必要账户凭据，不复制历史，且不修改日常桌面配置。操作系统限制跨组文件读取和访问另一组的 Harness 端口；开始前实际检查直接读取、子进程与符号链接。不是完整虚拟机隔离，共享外部服务仍可能使评测互相影响。

新建评测环境的 B 组使用统一 VibeGuide，包含项目记录工具；两组的差异包括功能，不能称为仅提示词不同。此前已经生成的评测环境保留其冻结的旧插件，不会被源码更新自动改动。

也可以直接使用两个已有目录，测试生成的代码会写回各自目录：

```sh
node scripts/manual-compare.mjs prepare \
  --standard-workspace "/path/to/default-test" \
  --vibeguide-workspace "/path/to/vibeguide-test"
```

两个目录必须独立且不能互相嵌套。可以分别从相同的原始提示词开始；若一组已生成文档或代码，不要把这些产物复制给另一组。准备器不自动覆盖或同步项目文件。聊天记录仍保存在独立的评测数据目录，项目文件访问限制只放行各自的工作区。

停止本轮：`node scripts/manual-compare.mjs stop --directory <本轮目录>`。start 恢复原有历史；新一轮使用 prepare 生成新目录。评测目录含登录凭据副本，请留在本地，分享时只导出对话和评分。准备和检查不会自动调用模型；发送消息后正常使用账户额度。

### 效果验证范围

接入通过不等于沟通效果通过。模型可能不遵循规则；原生问答 UI 操作、长对话压缩和用户理解验收仍待验证。已验证本地记录跨进程读取，但没有独立事实核验服务：用户原话来源可以验证，摘要含义与任务完成判断仍需实际评测。规则和动态上下文带来的实际费用、时延增量尚未系统测量。

`node scripts/eval-kickoff.mjs --live` 可通过本机已登录的 DeepSeek 账户进行四个有限的模型响应检查，会消耗模型额度。每例最多三次调用，只执行隔离的项目记录工具及明确允许的只读检查；修改项目或未允许的工具意图记录后停止。模糊需求案例会向模型提供受控的“问题待回答”结果，观察是否等待；不验证真实提问界面，也不等同于完整开发过程或真实用户理解评测。结果保存在本地忽略目录 `evals/runs/`。

## 项目资料

- [产品设计与功能优先级（2026-10-21）](docs/PRODUCT_DESIGN.md) · [实施计划与开发状态](docs/DELIVERY_PLAN.md)
- [P0 开发与试用说明](docs/CONTINUITY.md) · [连续任务试用材料](evals/continuity/README.md)
- [开发说明与验证记录](docs/DEVELOPMENT.md)
- [沟通规则](prompts/core.md) · [评测案例](evals/scenarios.json) · [评审标准](evals/RUBRIC.md)
- [原生对话设计](docs/CONVERSATION_FIRST_DESIGN.md)
- [历史首版规格](docs/IMPLEMENTATION_SPEC.md)
- [宿主与参考项目研究](docs/RESEARCH.md) · [用户痛点研究](docs/USER_RESEARCH.md)

`prototype/` 是用户已否定的早期侧栏演示，仅保留作设计对照；当前插件不使用该页面。
