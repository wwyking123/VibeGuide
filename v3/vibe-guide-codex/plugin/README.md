# Vibe Guide v3

DeepSeek Harness / DSH Desktop 的非技术用户导航插件。当前版本 `0.3.0-alpha.1`，可试用开发版。

- **想清楚**：逐轮访谈、可编辑任务卡、待定事项、完整交接说明复制。
- **陪我做**：原生工具失败与主 Agent 回复失败监测、同类问题聚合、白话解释和可复制建议。
- **划词侧问**：选中主对话文本，点击浮动的“解释 / 追问”，在独立小窗连续询问。
- **回顾**：手动或候选交付后自动生成阶段实施路线，展开查看来源与未验证事项。

自动模型请求使用当前会话模型，可在“⋯”中分别关闭。打开或刷新侧栏不调用模型。侧问和访谈没有执行工具，也不会发送主对话消息。当前只提供复制，不提供未经验证的草稿写入或原生右键菜单。

## 安装预构建包

解压后双击 `Install-VibeGuide.command`，或在此目录运行 `sh install.sh`。脚本从本地包安装，不下载 GitHub 旧版发布物，不需要另外安装 Node。

支持应用路径 `/Applications/DeepSeek Harness.app` 和 `/Applications/DSH Desktop.app`，自动识别 `desktop` 或 `web` profile；自定义安装可设置 `VIBEGUIDE_APP`、`VIBEGUIDE_HOME`。安装器保留原配置备份和旧插件副本，不修改模型或其他插件设置。

安装后，在空闲时完全退出并重开 DSH，新建或打开会话，选择 **VibeGuide** 模式，然后点击主对话顶部 **VibeGuide** 打开侧栏。无需访谈时创建任务后选择“带待定项开始”或在陪我做中启用跟踪。任务记录从创建时开始，不自动把历史项目认作本次成果。

## 开发与验证

Node.js >=22.18：

```sh
npm ci
npm test
npm run smoke:guide
npm run dev:guide
```

桌面 smoke 通过本机 Electron 运行隔离 Harness，使用固定回答而非真实模型；会启动仅本机访问的临时服务，不修改日常 profile。`dev:guide` 保留同一个隔离服务供界面检查。具体版本和结果见 `docs/v3/IMPLEMENTATION.md`。

当前源码开发时可复用本机已有 node_modules；分发包不含此符号链接，其他机器需 npm ci。本地安装预构建包不需要 node_modules。

## 数据、兼容与回退

v3 任务放在配置的 storageRoot/guide-v1/v3-*.json，共用原有原子存储和单写保护，旧记录不会被自动转换成已确认需求，旧发送队列不会恢复。任务可导出、删除；主会话和项目文件不会删除。旧版共享记录及安装备份不会随任务删除而清除。

macOS DSH Desktop 0.12.1、内部 Harness 0.2.1-rc.2 已完成隔离宿主与 UI 验证。其他桌面版本需重新验证。真人试用与真实模型质量评估尚未完成，不能把集成测试视为产品最终验收。

回退：关闭 DSH，使用安装回执中 backup 指向的旧配置恢复当前 profile 的 cordis.patch.yml，然后重新打开。不要删除旧插件副本；回退不会自动删除 v3 任务。

新版规范以 `docs/v3/` 的 PRD、技术设计、Spec 为准。仓库其他文档及旧通信服务测试仅作为历史或复用模块回归资料；v3 宿主只挂载 v3View/v3Action，不挂载旧发送 RPC。
