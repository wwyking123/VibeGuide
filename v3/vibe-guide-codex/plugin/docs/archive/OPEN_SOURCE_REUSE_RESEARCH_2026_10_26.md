# VibeGuide 开源复用调研与接入依据

调研日期：2026-10-26。服务于《技术架构与实现 v2.1》第 23-27 章。范围为原有五个候选，加上 React Flow、assistant-ui、Aider、OpenSpec、Techie，以及官方 DeepSeek Harness 接口实现。

## 1. 证据范围与结论

本轮读取了官方仓库、固定提交下的关键源码、包元数据和许可证；前五个项目沿用同日上一轮已检查的提交。只读克隆保存在临时目录，不属于产品依赖。没有安装候选插件、运行其测试、调用真实模型或修改用户宿主配置。源码存在、作者报告验证通过、VibeGuide 实际集成通过，属于不同证据等级。

选择依据：是否直接服务于“看懂变化、判断影响、准确提出修改”；是否可嵌入现有 Harness；是否保留项目隔离、原始要求和有效证据；是否增加不必要的服务、状态副本或用户操作。

**推荐组合：** 官方宿主接口承载右侧栏与消息投递；改造 dsh-explain 的独立解释模式；React Flow 作为嵌入式结构图首选候选；Memmy 的项目事实扫描、Mnemon 的分层上下文用于选择性改造。Archify 用于图解设计和可选导出，assistant-ui 用于交互借鉴及可选组件验证。Aider、OpenSpec、Techie 借鉴方法；Memobase 暂不作为运行服务。

“首选候选”是开发路线，不表示已经添加依赖。正文第 27 章规定实际采用前的验证出口。

## 2. 固定版本与许可证清单

版本为所读仓库的包声明，不证明同版本 npm 产物已经发布或与源码完全一致。实际引入时另行锁定发布产物、完整性摘要和传递依赖。

| ID | 项目／所读版本 | 固定提交 | 主体许可 |
|---|---|---|---|
| H1 | DeepSeek Harness，所读侧栏包 0.2.1-rc.3 | `22ddee3792402c3e70ec5f86a63c3e3e895a2f60` | [MIT](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/LICENSE) |
| R1 | dsh-explain，main 包 0.3.1 | `15504c26fe018008208c9975228763a4b523edaa` | [MIT](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/LICENSE) |
| R2 | Archify 3.2.0 | `81c6be8d87090670c45d08a8f97f9d29c5af0bec` | [Apache-2.0 及例外说明](https://github.com/tt-a1i/archify/blob/81c6be8d87090670c45d08a8f97f9d29c5af0bec/NOTICE) |
| R3 | dsh-mnemon 0.5.36 | `5a890e2c2ceb395b4aeb61f2ee60ceffb1136608` | [MIT](https://github.com/omdsh-dev/dsh-mnemon/blob/5a890e2c2ceb395b4aeb61f2ee60ceffb1136608/LICENSE) |
| R4 | memmy-agent 1.2.4 | `74b26fc78ebd14a784981ba8e83bebf878c20865` | [MIT](https://github.com/MemTensor/memmy-agent/blob/74b26fc78ebd14a784981ba8e83bebf878c20865/LICENSE) |
| R5 | Memobase，按提交锁定 | `358c16bbc6d687937d79bc2f984a11c3be8da901` | [Apache-2.0](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/LICENSE) |
| R6 | React Flow，@xyflow/react 12.12.0 | `bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18` | [MIT](https://github.com/xyflow/xyflow/blob/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/LICENSE) |
| R7 | assistant-ui，@assistant-ui/react 0.15.31 | `7beac6fc271435b8c60e842a8e5ba327725d25e2` | [MIT](https://github.com/assistant-ui/assistant-ui/blob/7beac6fc271435b8c60e842a8e5ba327725d25e2/LICENSE) |
| R8 | Aider，按提交锁定 | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | [Apache-2.0](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt) |
| R9 | OpenSpec，按提交锁定 | `6d04a1b58dedc95729d34e4f223d9d483aae210a` | [MIT](https://github.com/Fission-AI/OpenSpec/blob/6d04a1b58dedc95729d34e4f223d9d483aae210a/LICENSE) |
| R10 | Techie，按提交锁定 | `ffb92c7b6b58e69d9dec0fca9cd462020ea48110` | [MIT](https://github.com/dhpwd/techie/blob/ffb92c7b6b58e69d9dec0fca9cd462020ea48110/LICENSE) |

Archify 当前主体不是任选 MIT／Apache 的双许可：NOTICE 保留历史 MIT 授权，单独版本的 Harness 适配器仍为 MIT，内置 Skill 随所打包来源的许可。只读调研不产生代码分发；实际复制、改编或打包时必须记录对应文件的许可及第三方声明。

## 3. H1：官方 DeepSeek Harness

**源码依据：** [右侧栏契约](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/docs/subsystems/sidebar-right.md)、[原生 files 页注册示例](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/client/ui-sidebar-files/src/client/index.ts)、[消息提交与去重实现](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/api/session-controller/src/commands.ts)、[会话控制说明](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/api/session-controller/README.md)。

- 已观察：侧栏类型注册与 keyed slot 内容注册分开；按会话管理布局。`prompt` 以 requestId 检查 inbox 和已有用户事件的 rpcId，区分 followup／steer；accepted 表示接收。客户端提交回显不等于持久记录。
- 复用方式：调用目标宿主的服务，参考 files 页的注册和清理方式；不复制内部 dockkit、宿主服务注册表或第二份 React。
- VibeGuide 适配：独立 Tab；三个内部入口；从可信会话解析项目；关闭视图只退订；普通修改优先 followup，只有明确要求打断且宿主支持时才考虑 steer。
- 限制：本轮上游源码的侧栏包为 rc.3，技术文档既有本机基线为 rc.2。此次未重新检查本机版本，不要求用户为调研升级；必须验证目标版本接口、权限与重启后的对账行为。
- 出口：在锁定宿主内加载最小 Tab，验证两会话切换、卸载重装、忙碌时接收、同请求超时后核对，不以源码存在代替实测。

## 4. R1：dsh-explain

**源码依据：** [observer.ts](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/src/observer.ts)、[scheduler.ts](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/src/scheduler.ts)、[queue.ts](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/src/queue.ts)、[explainer.ts](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/src/explainer.ts)、[client/index.ts](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/src/client/index.ts)。

- 已观察：分页读取已完成回合，限制来源材料长度；独立模型调用、调度及预算；会话视图和解释快捷入口；用户纠正优先于模型推断。自动候选队列是内存 Map，同一来源保留最新候选，不能当作完整持久事件队列。
- 复用方式：改编来源采集、调用封装、取消与预算控制、客户端通信模式，落到 `guide/host`、`guide/explanation`。先抽离宿主兼容边界，避免把完整学习产品作为必装插件。
- 必改：全局学习上下文改为项目范围；原始事件先进入我们的持久队列；讲解输出绑定 Basis；完成时再查版本；评估、复习、掌握状态不进入本版。显式修改交给自己的 DeliveryWorker。
- 补足：回合结束捕获无法覆盖全部外部文件变化，仍需文件索引重检和事件缺口检测。会话视图注册不等于右侧栏注册。
- 出口：解释生成时主线继续；取消只取消本次解释；A 项目的晚到结果不进入 B；依据过时的解释不能作为当前结论。
- 版本注意：[README](https://github.com/yuezengwu/dsh-explain/blob/15504c26fe018008208c9975228763a4b523edaa/README.md) 区分 main 的新宿主支持与 v0.3.1 标签的旧兼容范围；包内同名版本不能替代提交锁定。

## 5. R2 与 R6：Archify、React Flow

**Archify 依据：** [架构图 schema](https://github.com/tt-a1i/archify/blob/81c6be8d87090670c45d08a8f97f9d29c5af0bec/archify/schemas/architecture.schema.json)、[来源校验](https://github.com/tt-a1i/archify/blob/81c6be8d87090670c45d08a8f97f9d29c5af0bec/archify/renderers/shared/repository-evidence.mjs)、[讲解来源处理](https://github.com/tt-a1i/archify/blob/81c6be8d87090670c45d08a8f97f9d29c5af0bec/archify/explainer/sources.mjs)、[路径高亮](https://github.com/tt-a1i/archify/blob/81c6be8d87090670c45d08a8f97f9d29c5af0bec/viewer/route-probe.js)。

**React Flow 依据：** [组件属性](https://github.com/xyflow/xyflow/blob/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/packages/react/src/types/component-props.ts)、[包及 React 依赖](https://github.com/xyflow/xyflow/blob/bb63f4cc345acf4e6c73e0371be3ea3ca01b2a18/packages/react/package.json)。

- Archify 已有结构化图、SVG/HTML 渲染、来源绑定和沿既有边查路径。适合参考“解释关联图中位置”和可选静态导出。路径可达只证明输入关系可达，不证明运行时依赖或修改必然影响。
- React Flow 是 React 节点交互库，提供自定义节点、选择、视口与键盘相关配置，较适合现有 React 侧栏。它不扫描仓库、不生成业务架构，也不自动证明图的语义正确；布局仍需我们提供。
- 决策：正式侧栏首选验证 React Flow；Archify 保留图解与来源设计参考，导出列为后续可选，不同时塞进两套交互运行时。小图允许原生 SVG 回退，不扩大课程版功能范围。
- 映射：`ProjectProjection` 输出稳定 nodeId／edgeId、业务职责、sourceRefs、Basis 和 observation／inference；`StructureView` 只消费投影。关闭拖拽编辑、连线、重连与删除，保留点击、键盘选择和缩放；节点级属性不得重新开启编辑。
- 限制：Graph 视口与侧栏滚动需避免抢焦点；默认增量更新不自动 fitView，不覆盖用户视角。用清单提供等价的键盘阅读入口。不能将 raw HTML、脚本或模型生成组件直接插入宿主。
- 出口：窄栏、深色主题、键盘导航；节点 ID 稳定；新变化只突出相关节点；切换项目不沿用旧视角。React Flow 兼容声明不等于 Harness 打包兼容，需要测单份 React 和资源加载。
- Archify 的 [Harness 包](https://github.com/tt-a1i/archify/blob/81c6be8d87090670c45d08a8f97f9d29c5af0bec/integrations/deepseek-harness/README.md) 为 Skill-only，打包来源为较早的 3.0.1；不能用这个适配包宣称当前 3.2.0 图解功能已接入侧栏。

## 6. R7：assistant-ui

**源码依据：** [ExternalStoreAdapter](https://github.com/assistant-ui/assistant-ui/blob/7beac6fc271435b8c60e842a8e5ba327725d25e2/packages/core/src/runtimes/external-store/external-store-adapter.ts)、[阅读位置与滚动实现](https://github.com/assistant-ui/assistant-ui/blob/7beac6fc271435b8c60e842a8e5ba327725d25e2/packages/store/src/utils/thread-viewport-auto-scroll.ts)、[包依赖](https://github.com/assistant-ui/assistant-ui/blob/7beac6fc271435b8c60e842a8e5ba327725d25e2/packages/react/package.json)。

- 已观察：外部状态适配器以消息、运行状态与回调驱动界面；可区分禁用全部输入和仅禁止发送；支持消息分页；滚动实现保存可见消息偏移。部分扩展接口标记 unstable。
- 复用方式：先借鉴阅读锚点、流式状态和受控输入；当侧栏对话组件需求足够多时，再验证最小 `@assistant-ui/react` 组合。默认无需云服务，不引入它的后端代理或第二套主会话历史。
- 必改：`onNew` 只能调用 `GuideService.submitInput`，由意图服务路由；禁止组件直接发送宿主 prompt。`onCancel` 只取消解释 requestId。不给前端工具执行回调；不启用编辑主历史、重新执行主线等能力。
- 风险：其 UI 队列不等于持久 outbox；客户端显示运行中不等于主 AI 已收到要求；自动滚动默认值不能覆盖“固定阅读”。依赖较多，需与宿主 React 和现有样式做最小打包比较。
- 出口：阅读旧消息时新流不拉到底；输入草稿不丢；旧 requestId 流被丢弃；关闭面板不停止主开发。若成本不合适，使用自有受控组件实现同一契约。

## 7. R4 与 R8：Memmy 项目扫描、Aider Repo Map

**Memmy 依据：** [local-scanner.ts](https://github.com/MemTensor/memmy-agent/blob/74b26fc78ebd14a784981ba8e83bebf878c20865/Memory/src/service/project-environment/local-scanner.ts)、[manifest-parsers.ts](https://github.com/MemTensor/memmy-agent/blob/74b26fc78ebd14a784981ba8e83bebf878c20865/Memory/src/service/project-environment/manifest-parsers.ts)、[scan-policy.ts](https://github.com/MemTensor/memmy-agent/blob/74b26fc78ebd14a784981ba8e83bebf878c20865/Memory/src/service/project-environment/scan-policy.ts)、[workspace-identity.ts](https://github.com/MemTensor/memmy-agent/blob/74b26fc78ebd14a784981ba8e83bebf878c20865/Memory/src/service/namespace/workspace-identity.ts)。

**Aider 依据：** [repomap.py](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)。

- Memmy：受限文件扫描、忽略规则、稳定读取、文件哈希，及从清单提取语言、构建／检查入口。复用时拆出纯文件分析和事实解析，去掉默认运行时探测命令；它不是完整业务架构提取器。
- Aider：Tree-sitter 符号提取、图排名和 token 预算选择。借鉴“优先读与问题相关的文件和入口”，不引入 Python 全栈或整套编码代理；初版先用已有 TS 能力、清单和 import 关系，其他语言明确覆盖边界。
- 缓存调整：Aider 的 tags 缓存检查 mtime，可作为性能启发，不能直接作为我们的证据有效性规则。VibeGuide 以内容哈希、项目身份和索引器版本决定是否复用；语言解析器变化也需要重建。
- 事实顺序：清单／语法可确认事实 → 带来源的关系 → 模型候选业务职责 → 标记推断。技术栈声明、测试脚本存在，都不能被显示为功能或测试已经通过。
- 出口：小型网页、已有项目、无 Git 项目；文件删除／改名、跨目录符号链接、大文件和扫描中修改；超预算返回部分覆盖，不假装完整扫描。
- Memmy 全套跨 Agent 记忆与代理运行系统暂不引入；跨宿主不是当前产品范围。

## 8. R3 与 R5：Mnemon、Memobase

**Mnemon 依据：** [三层策略](https://github.com/omdsh-dev/dsh-mnemon/blob/5a890e2c2ceb395b4aeb61f2ee60ceffb1136608/plugins/dsh-mnemon-strategy-default-three-tier/src/strategy.ts)、[工作区身份](https://github.com/omdsh-dev/dsh-mnemon/blob/5a890e2c2ceb395b4aeb61f2ee60ceffb1136608/src/sdk/workspace-storage.ts)、[存储配置](https://github.com/omdsh-dev/dsh-mnemon/blob/5a890e2c2ceb395b4aeb61f2ee60ceffb1136608/src/host/config.ts)、[自动记录指引](https://github.com/omdsh-dev/dsh-mnemon/blob/5a890e2c2ceb395b4aeb61f2ee60ceffb1136608/plugins/dsh-mnemon-strategy-auto-capture/src/index.ts)。

**Memobase 依据：** [严格画像配置](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/example_config/only_strict_profile/config.yaml)、[画像提取提示](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/prompts/zh_extract_profile.py)、[后台处理](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/api/memobase_server/controllers/buffer_background.py)、[部署依赖](https://github.com/memodb-io/memobase/blob/358c16bbc6d687937d79bc2f984a11c3be8da901/src/server/readme.md)。

- Mnemon：短工作上下文常驻、项目文档和长期证据按需读取，策略与来源解耦；支持工作区身份，但默认存储为 global，不能直接作为双项目隔离默认值。主动记录扩展是当前模型的指引，不是保证每条事件处理成功的持久任务。
- 借鉴它的上下文预算、作用域和读写来源展示；优先实现在自己的 ContextResolver 上，避免两个插件都写用户要求。若未来接 Source SDK，先做只读来源适配，全部写操作仍由 VibeGuide 的来源与语义校验处理。
- Memobase：借鉴可配置画像字段、事件与后台整理；其默认提示允许推断隐含偏好，因此不得直接用于正式需求。暂不新增 Python、Postgres、Redis 服务，也不采集与沟通无关的人口、心理画像。
- 用户可见输出：“这次参考了你在本项目提出的保存范围”，支持纠正。不得从提问、已读或相关性排名推出同意／掌握。
- 出口：个人偏好与项目要求分开；双工作区不串记录；“为什么不用云端”不新增云端需求；保留否定、数字和例外；过时证据不进入当前上下文；纠正后不被旧摘要再次覆盖。

## 9. R9 与 R10：OpenSpec、Techie

**OpenSpec 依据：** [spec-driven schema](https://github.com/Fission-AI/OpenSpec/blob/6d04a1b58dedc95729d34e4f223d9d483aae210a/schemas/spec-driven/schema.yaml)。

**Techie 依据：** [explain Skill](https://github.com/dhpwd/techie/blob/ffb92c7b6b58e69d9dec0fca9cd462020ea48110/skills/explain/SKILL.md)、[项目说明](https://github.com/dhpwd/techie/blob/ffb92c7b6b58e69d9dec0fca9cd462020ea48110/README.md)。以上 Skill 文件作为调研对象阅读，本轮没有执行这些 Skill。

- OpenSpec：把用户可观察行为、设计和任务分开，按一次变更记录规格增量。借鉴到 ChangeSet／需求修订的关联，不引入完整 CLI 或要求用户先填 proposal/spec/design/tasks。写出验收场景与勾完任务，都不代表行为已经验证。
- Techie：先说明发生了什么、对用户意味着什么、下一步；技术细节按需展开。改写为我们的业务影响模板，继续保留来源、不确定性和验证边界；不能照搬过度简化或默认“没事”的措辞。
- 明确排除：Techie 的终端设置、恢复与保存检查点命令；OpenSpec 的全套显式流程作为产品入口；任何第二套审批与知识测试。
- 出口：同一案例的用户能指出影响和提出修改；澄清只问未定的产品行为；技术术语少不代表解释正确，仍核对事实和真实原话。

## 10. 必须由 VibeGuide 自己完成的闭环

1. **有效事实与业务后果之间的转换。** 来源准确也可能解释错；保留 observation／inference、不确定性与 Basis，针对关键影响做验证。
2. **追问、偏好、纠正、明确修改的区分。** 当前输入是授权来源；从检索文本或模型推断不能获得发送权限。
3. **可靠转交。** 在 guide.json 原子保存原话和发送工作；稳定 requestId；服务端从宿主接收／持久事件对账。未知状态不自动换 ID 重发；回执、执行与检查分开。
4. **失效传播。** 文件／要求版本变化使相关观察、图与解释待核对，不能将代码变化反向覆盖用户要求。
5. **不打断的交互。** 看旧解释时固定阅读，新变化仅提示；侧栏关闭不影响主线；解释取消与主 AI 取消分开。

## 11. 引入顺序与交付记录

| 阶段 | 选用或参考对象 | 记录与出口 |
|---|---|---|
| P0 | H1；R1 的模型调用与桥接模式 | 真实宿主能力表、固定版本、原生 Tab、正确会话、独立调用和接收回执 |
| P1 | R3 的范围规则；R9 的记录关联方法 | 自有持久队列、语义保真和失效传播；不更换权威存储 |
| P2 | R1；R4 的受限扫描；R10 的表达结构 | 当前变化解释和最小转交闭环；无新后台服务依赖 |
| P3 | R6 首选验证；R2 图解参考；R7 可选组件 | 窄栏、焦点与阅读位置、版本更新；打包成本可接受 |
| P4-P5 | 全部已采用模块的边界与回归 | 超时、重启、双项目与真实用户试用；三类场景完整交付 |

每项真正引入时，在实现 PR 中记录：上游 URL／提交、实际包版本与完整性、复用文件、修改点、许可证、依赖、目标宿主、运行证据和维护边界。引入的代码在仓库保留清晰来源声明；新增第三方说明文件只列实际打包的内容，避免把调研清单伪装成依赖清单。

本轮交付是设计与调研更新。没有证据支持“已经复用完成”或“非技术用户体验已经验证改善”。
