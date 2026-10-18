# VibeGuide 开发说明

更新：2026-10-18。版本：0.1.0-alpha.2。规则版本：2026-10-18.1。

## 桌面版安装适配（alpha.2）

安装时发现正在运行的桌面版为 `0.2.1-rc.2`，与 `/opt/homebrew/bin/dsh` 的 `0.1.0-rc.6` 不同。桌面版使用 `dsh-agent-preset` 声明和 `dsh-agent-preset-registry`，不再扫描旧 `.agent-presets` 目录。

新增 `scripts/desktop.mjs`、`install-desktop.mjs`、`smoke-desktop.mjs`。直接使用桌面版 Electron 的 Node 模式读取并加载安装包中的真实宿主模块；不启动第二个桌面窗口。安装器复制新版标准预设声明，保留全部子插件，通过独立 Include 将 VibeGuide 注册到 desktop profile。为避免 profile 外部目录的包查找差异，声明中的宿主模块引用指向当前桌面版自带模块的文件 URL。

写入前验证原配置语义不变并备份原始字节；只新增 VibeGuide 声明，不改变模型和默认预设。需要重启桌面版生效。若卸载，先关闭 Harness，从 profile patch 移除 `id: vibeguide-presets` 的插入项，再移走对应插件目录；原始备份用于核对，不应覆盖安装后新增的其他设置。

已通过真实桌面版隔离环境测试：预设可发现、创建真实 Agent、31 项标准工具定义一致、原生提问可用、普通会话隔离，且浏览器打开次数为 0。未调用模型。下文的 25 项工具与目录型 preset 描述仅适用于旧 CLI 接入。

## 实现范围

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

## 下一阶段

1. 在真实会话中验证公司官网从零开发、已有报名工具修改，检查问题是否直接可懂、重要要求是否保留。
2. 同模型比较原生、普通白话提示、VibeGuide，保存全部输出、失败、追问次数、用量与耗时，按评审量表盲审。
3. 单独验证压缩、恢复、目标变化与多 Agent 场景，再判断是否需要额外任务记录。
4. 若简单提示效果相同，缩减规则；若主要失败来自上下文遗失，再实现可追溯摘要。

## 协作边界

主代理负责规则、全部插件/安装/测试代码、依赖、打包和文档。agy 只写评测案例和量表，交付后由主代理统一修订；kiro 只读核对 API 并审查实现。没有两个 Agent 同时修改核心文件。
