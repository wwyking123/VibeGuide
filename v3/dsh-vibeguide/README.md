# dsh-vibeguide

DeepSeek Harness（DSH）插件，帮非技术同学用 AI 做东西时：

- **想清楚**：先问几个关键问题，再整理成需求简报，填进主对话。
- **卡住了**：主 AI 出问题时自动提醒，用白话说明原因，并给出可以一键填入的出路。
- **看不懂**：在主对话里划词，就能看到白话解释，也可以接着追问。

插件不改主 AI 的行为，也不替你发消息：所有"填入主对话"都只是把文字填进输入框，发不发由你决定。

**当前版本**：0.3.0-m1（M1，内部验证版）。测试过的宿主：DSH Desktop 内置 `@deepseek-ai/dsh` 0.2.1-rc.2。详细情况见 [docs/M1_REPORT.md](../docs/M1_REPORT.md)。

## 开发

不需要构建，也没有依赖。

```bash
npm test
```

在隔离环境里试用。不要装进日常使用的 DSH 数据目录，步骤见 [spikes/m0/README.md](../spikes/m0/README.md)：

```bash
node dev/fake-llm.mjs 18080
```

然后用临时的 `DSH_HOME` 启动宿主，并设置 `DEEPSEEK_BASE_URL=http://127.0.0.1:18080`。安装插件时用 `dsh plugin --profile web add link:$PWD`。

注意：修改 `src/host/` 下的代码后要重启宿主才生效；修改 `src/client/client.js` 后刷新页面即可。

## 文档

- [PRD](../docs/PRD.md)：做什么、为什么
- [技术设计](../docs/TECH_DESIGN.md)：怎么做
- [SPEC](../docs/SPEC.md)：实现不能越过的线，以及怎样才算做完
- [M0 验证报告](../docs/M0_REPORT.md)
- [M1 实现报告](../docs/M1_REPORT.md)
