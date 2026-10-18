# VibeGuide

**Make technical systems legible to non-technical people.**

让 DeepSeek Harness 中同一个开发 AI 直接说清楚：准备做什么、需要你决定什么、实际做到了什么。用户继续使用原来的对话与提问界面。

当前版本：**0.1.0-alpha.2，开发验证版**。已适配本机 Harness 桌面版 `0.2.1-rc.2`，同时保留旧 CLI `0.1.0-rc.6` 的安装器。真实模型对照评测与用户试用尚未完成。

## 已实现

- 生成回答前加入持续沟通规则，覆盖方案、可行性、业务选择、开发进展、失败和完成说明。
- 安装为独立的 **VibeGuide 会话预设**，完整复制本机 Harness 标准开发配置，再添加插件。
- 使用宿主原有模型、标准工具和原生提问；已验证桌面版 31 项、旧 CLI 25 项工具完整保留。插件自身不发模型请求，不需要额外 API key。
- 普通会话不加载规则；VibeGuide 不另建用户状态或聊天数据库。
- 10 个中文场景及中性的三组对照评审标准。

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
- 桌面版更新：暂不提供自动更新或 `--id` 参数；重复安装会拒绝覆盖。副本不会自动跟随宿主升级。
- 桌面版移除：先关闭 Harness，从 `profiles/desktop/cordis.patch.yml` 移除 `id: vibeguide-presets` 对应的插入项，再移走该项引用的插件目录。备份用于核对，不应直接覆盖安装后新增的其他设置。
- 旧 CLI 更新：使用新 ID 安装，例如 `--id vibeguide-next`，重启 Harness 后创建新会话。安装器拒绝覆盖已有目录和宿主自带预设名。
- 旧 CLI 移除：停止 Harness 后，将 `.agent-presets/vibeguide` 文件夹移到预设目录之外保存；移回原处即可恢复。若曾设为默认，先在宿主改回 standard。
- 打包：`mkdir -p artifacts && npm pack --pack-destination artifacts`。生成本地安装包，不发布到 npm。解压后的包自带 `dist/`，可直接运行对应宿主的安装脚本。

## 当前边界

接入通过不等于沟通效果通过。模型可能不遵循规则；尚未开展真实模型对照、原生问答 UI 验证、长对话压缩/恢复与用户试用。当前复用宿主历史，没有额外任务记忆或事实核验服务。规则增加约 5.9 KB 提示文本；实际 token、费用和时延增量尚未测量。

## 项目资料

- [开发说明与验证记录](docs/DEVELOPMENT.md)
- [沟通规则](prompts/core.md) · [评测案例](evals/scenarios.json) · [评审标准](evals/RUBRIC.md)
- [原生对话设计](docs/CONVERSATION_FIRST_DESIGN.md)
- [首版规格](docs/IMPLEMENTATION_SPEC.md) · [实施计划](docs/DELIVERY_PLAN.md)
- [宿主与参考项目研究](docs/RESEARCH.md) · [用户痛点研究](docs/USER_RESEARCH.md)

`prototype/` 是用户已否定的早期侧栏演示，仅保留作设计对照；当前插件不使用该页面。
