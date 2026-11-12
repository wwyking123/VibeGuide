# VibeGuide

**Make technical systems legible to non-technical people.**

DeepSeek Harness 的插件，面向不懂技术、用 AI 做产品的人：

- **白话沟通规则**：让主对话里的开发 AI 直接说清楚准备做什么、需要你决定什么、实际做到了什么。
- **VibeGuide 侧栏**：随时问看不懂的地方，看项目做到哪一步；有具体改法时一键发到主对话。

当前版本 **0.2.0-alpha.11，开发验证版**。适用于 macOS 桌面版 Harness `0.2.1-rc.2` / `0.2.1-rc.3`；同一 0.2.x 线上更新的 Harness 也能加载，设置页会提示“还没一起测试过”。还没有做过真人试用。

## 侧栏怎么用

- **进展**：一句话状态；卡住时有排障卡；你在主对话提过的要求按“还在做 / 可以试用了 / 已完成”列出。
- **项目结构**：按“用户看到的 → 背后的规则 → 数据存在哪里 → 外部服务”四层列出各部分，标出能用 / 模拟 / 还没做；文档、设计稿和测试脚本收在“开发用的资料”里。顶部显示 AI 总结的产品名。
- **提问**：底部输入框只用来问，不会发出开发任务。第一次打开时有两个示例问题。
- **划词提问**：在主对话里选中看不懂的词或一段话，旁边出现「问问这个」，点一下就带着选中的内容进侧栏提问。直接发送会问“这是什么意思？”，也可以写自己的问题；常见术语由本地词库直接回答，不调用模型。只在 VibeGuide 模式的会话里出现。做法参考了 [dsh-selection-toolbar](https://github.com/suiyideali/dsh-selection-toolbar)。
- **修改**：在主对话直接说，包括“标题太长了”这类不满意，侧栏会记成要求。讲解里有具体改法时，点“发到主对话”，侧栏 AI 写好要求直接发出，算作你的要求，并自动带上本项目相关的旧约定。
- **设置（齿轮）**：讲解方式、每日和每轮次数上限、历史记忆。

打开、刷新和切页不调用模型。提问、生成概览和一键代发才会调用当前会话选的模型，计入次数上限。产品决定见[侧栏精简与转交方式](docs/reviews/2026-11-02-sidebar-simplification.md)。

## 安装与更新

需要 Mac 和 `/Applications/DeepSeek Harness.app`，并且至少打开过一次。打开“终端”，粘贴这一行，回车：

```sh
curl -fsSL https://raw.githubusercontent.com/wwyking123/VibeGuide/release/install.sh | sh
```

下载不动时换这个镜像地址：

```sh
curl -fsSL https://cdn.jsdelivr.net/gh/wwyking123/VibeGuide@release/install.sh | sh
```

看到“安装好了”后，完全退出并重新打开 Harness，新建会话，在输入框上方的模式菜单选 **VibeGuide**，从右侧打开 VibeGuide 侧栏。以后更新也是同一条命令。

不需要 Node 或 git：脚本下载预先构建好的包，用 Harness 自带的运行环境执行安装器。安装器先在本机做一次自检（在临时文件夹里试存、试读），通过后才改动设置。它把插件放在 `~/.dsh/plugins/` 下，在 `profiles/desktop/cordis.patch.yml` 增加一项声明，原文件备份到 `~/.dsh/.vibeguide-backups/`。不会改动模型设置和其他配置。

### Windows（测试中）

Windows 版的安装命令已经写好，但**还没有在真实的 Windows 电脑上验证过**。愿意帮忙测试的话，打开 PowerShell，先运行只读的环境检查，把输出发给作者：

```powershell
$env:VIBEGUIDE_CHECK = '1'; irm https://raw.githubusercontent.com/wwyking123/VibeGuide/release/install.ps1 | iex
```

检查不会改动任何东西。确认没问题后，先完全退出 Harness，再运行安装：

```powershell
irm https://raw.githubusercontent.com/wwyking123/VibeGuide/release/install.ps1 | iex
```

- **停用**：新会话选「标准模式」。
- **移除**：关闭 Harness，从 `cordis.patch.yml` 删掉 `id: vibeguide-presets` 那一项，再移走它引用的插件目录。
- **记录**：侧栏记录保存在 `~/.dsh/vibeguide-p0-state/`（沿用旧路径），停用不会删除。
- **Harness 换到 0.2 以外的版本**：侧栏会停用并提示更新 VibeGuide，主对话不受影响。

## 开发与检查

从源码安装需要 Node.js ≥ 22.18：`git clone` 后运行 `npm ci`，再运行 `npm run install:desktop`。

```sh
npm test               # 单元测试
npm run smoke:guide    # 在隔离的真实 Harness 里走完整流程，用固定回答，不调用模型
npm run dev:guide      # 启动同样的隔离环境，供浏览器里查看侧栏
npm run eval:sidebar   # 用你登录的 DeepSeek 账号做真实模型评测，会消耗额度
```

`node scripts/smoke-guide-desktop.mjs --installed <插件目录>` 可以检查已安装的副本。`sh scripts/release.sh` 跑完测试后，把构建好的包和 `install.sh`、`install.ps1` 提交到本地 `release` 分支；`git push origin release` 之后，一键安装命令才会拿到新版本。评测用例在 `evals/sidebar/`，结果写到 `evals/runs/`（不进仓库）。最近一次结果见[侧栏模型评测](docs/reviews/2026-11-03-sidebar-model-eval.md)。

## 项目资料

- [产品文档 v2.2](docs/VIBEGUIDE_PRODUCT_V2_2.md) · [技术设计 v2.2](docs/VIBEGUIDE_TECHNICAL_DESIGN_V2_2.md)：与后来的决定冲突时，以 `docs/reviews/` 里的记录为准
- [沟通规则](prompts/core.md)
- [用户痛点研究](docs/USER_RESEARCH.md) · [宿主与参考项目研究](docs/RESEARCH.md)
- [历史文档](docs/archive/README.md)：旧版“项目续接”、六项开发能力、旧 CLI 版本等，代码已在 0.2.0-alpha.8 删除

`prototype/` 是早期被否定的侧栏演示，只留作设计对照。
