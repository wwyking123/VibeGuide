# VibeGuide v3

这是 VibeGuide 的第三版：一个 DeepSeek Harness（DSH）插件，帮非技术同学用 AI 做东西。它从零重新设计、从零实现，**和仓库根目录下的 0.2 版是两套独立的东西**：包名、接口前缀、数据目录都不一样，代码互不引用。

插件做三件事：

- **想清楚**：开工前只问几个关键问题，整理出一份需求简报，填进主对话。
- **卡住了**：主 AI 遇到断网、限流、额度不足、缺依赖、反复失败等情况时，自动用白话说明原因，并给出可以一键填入的处理办法。
- **看不懂**：在主对话里划词，就能看到白话解释，也可以接着追问。

插件不改主 AI 的行为，也不替你发消息。

## 目录

| 路径 | 内容 |
| --- | --- |
| [docs/PRD.md](docs/PRD.md) | 产品需求：做什么、为什么、决策记录 |
| [docs/TECH_DESIGN.md](docs/TECH_DESIGN.md) | 技术设计：怎么做，标注了哪些已实测 |
| [docs/SPEC.md](docs/SPEC.md) | 实现约束与验收规格：不能越过的线，以及怎样才算做完 |
| [docs/M0_REPORT.md](docs/M0_REPORT.md) | M0 技术验证：宿主能力的实测结果 |
| [docs/M1_REPORT.md](docs/M1_REPORT.md) | M1 实现报告：做了什么、测了什么、怎么装进 DSH Desktop |
| [docs/M1_FIXLIST.md](docs/M1_FIXLIST.md) | 按 SPEC 核对出来的待修清单 |
| [dsh-vibeguide/](dsh-vibeguide/) | 插件代码（纯 JS，零依赖，不需要构建）和测试 |
| [spikes/m0/](spikes/m0/) | M0 用的探测插件、假模型服务，以及在隔离宿主里复现测试的步骤 |
| [demo-video/](demo-video/) | 功能示意视频的制作脚本和成片 |
| [vibe-guide-redesign.md](vibe-guide-redesign.md) | 最早的方向讨论 |
| [vibe-guide-codex/](vibe-guide-codex/) | **另一套独立的 v3 实现**（0.3.0-alpha.1，TypeScript），由另一个工具从旧项目复制后单独开发，附有它自己的 PRD、Spec、技术设计和实现记录。它和 `dsh-vibeguide/` 是两套不同的代码，互不依赖。按它自己的 `.gitignore`，构建产物 `dist/` 和安装包 `artifacts/` 没有上传，需要自己构建 |
| [install-vibeguide-dsh-desktop.mjs](install-vibeguide-dsh-desktop.mjs) | 把**旧版** 0.2 装进 DSH Desktop 的适配脚本，仅作留档。运行它会把旧版装回来 |

上传前已经把文档里本机用户名的路径换成了 `~`。

## 当前状态（2026-11-12）

- **代码**：`dsh-vibeguide` 当前版本 0.3.0-m1.1。M1 范围内的功能已实现，`npm test` 的 112 项测试全部通过；在隔离的 DSH 0.2.1-rc.2 里实际点击操作过一遍。
- **未达标**：按 [SPEC](docs/SPEC.md) 12.3 还没满足退出条件。[待修清单](docs/M1_FIXLIST.md) 里列了需要先修的问题，以及还没做的真实模型评测和内部试用。
- **还没做**：M2（白话路线、思路偏移等判断）。

## 跑测试

```bash
cd dsh-vibeguide && npm test
```
