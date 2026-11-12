# VibeGuide 技术设计文档

| 项目 | 内容 |
| --- | --- |
| 版本 | v3.0 草稿（从零设计） |
| 日期 | 2026-11-12 |
| 对应 PRD | [PRD.md](PRD.md) |
| 约束与验收 | [SPEC.md](SPEC.md)：实现不得违反的约束、测试必须覆盖的内容、里程碑退出条件 |
| M0 验证 | [M0_REPORT.md](M0_REPORT.md)（2026-11-12，13 项全部有结论；本文已按结果更新，标为 [已实测]） |
| 目标宿主 | DSH Desktop（内置 `@deepseek-ai/dsh` 0.2.1-rc.2，profile `web`）；DeepSeek Harness 0.2.x |

**事实标注**：

- **[已核实]**：在本机宿主包或参考插件的源码中直接读到。
- **[推断]**：根据代码旁证推出，尚未运行验证。
- **[待验证]**：需要在 M0 里验证（清单见第 11 节）。
- **[已实测]**：M0 在隔离宿主中实际运行验证过（见 [M0_REPORT.md](M0_REPORT.md)）。

---

## 1. 宿主事实

### 1.1 来源

- **宿主包**：`/Applications/DSH Desktop.app/Contents/Resources/app.asar`，只做静态检索，没有运行。
- **参考插件**：只读源码，没有运行。
  - [suiyideali/dsh-selection-toolbar](https://github.com/suiyideali/dsh-selection-toolbar)，下文简称 sel。
  - [Renzic-Stone/DSH-EasyRewrite](https://github.com/Renzic-Stone/DSH-EasyRewrite)，下文简称 easy。
- **安装位置**：DSH Desktop 的数据目录是 `~/Library/Application Support/dsh-desktop/harness`，使用的 profile 是 `web`。[已核实]

### 1.2 插件打包与安装

- **`package.json`** [已核实：sel、easy]：
  - `main` 指向宿主端入口。
  - `exports["./client"]` 指向浏览器端 bundle。
  - `dsh` 块声明 `bundle.patch: "./cordis.patch.yml"` 和 `client.platform: "web"`。
- **`cordis.patch.yml`**：`- insert: [{ id: <pkg>, name: <pkg> }]`。[已核实]
- **安装** [已核实]：
  - 桌面版通过应用内的「插件 → 添加插件」安装（支持 `github:owner/repo`、npm 包名、本地路径）。
  - `desktop` profile 拒绝命令行安装。
  - `web` profile 可以用 `dsh plugin --profile web add …`。
  - 插件会成为 profile 目录下的 pnpm 依赖。
- **客户端 bundle 契约** [已核实]：`window.__ModuleLoader__.load({ id, factory(require) })`。
  - `factory` 返回 `{ inject: [...services], apply(ctx) }`。
  - React 由宿主通过 `require('react')` 提供，不要另外打包一份。
- **前后端通信** [已核实]：客户端没有宿主 RPC 可用，两个参考插件都用同源 `fetch` 访问宿主端用 `webServer.register` 注册的路由。

### 1.3 宿主端服务与事件

| 能力 | 接口 | 状态 |
| --- | --- | --- |
| 注册 HTTP 路由 | `webServer.register({ kind: 'exact', path, handler })` | [已核实：sel] |
| 请求准入 | `ctx.get('connection').requestRejection(req)` | [已核实：sel；宿主包中存在] |
| 读取会话 | `sessionQuery.readSession(sessionId)` → `{ events }` | [已核实：sel；宿主包中存在] |
| 调用模型（不带工具） | `llm.stream({ provider, model, messages, signal })`，流中有 `text-delta` 和 `finish{ reason.kind }` | [已核实：sel] |
| 默认模型 | `agentDefaultModel.currentSelection()` → `{ provider, model }` | [已核实：sel] |
| Agent 状态 | `ctx.on('agent/status', ({ agent, status }))`，`status` 只有 `idle` / `running` | [已实测] |
| Agent 错误 | `ctx.on('agent/error', ({ agent, turn, step, error }))`，`error.failure.code` 为模型错误码 | [已实测] |
| 授权请求 | `ctx.on('approval/request', (req, next))`，waterfall 型；`req = { agent, toolName, callId?, reason? }`。插件只观察，原样 `return next()` | [已核实：源码]；会话里另有 `approval/asked`、`approval/decided` 事件 |
| 向用户提问 | `user-questions/request`，waterfall 型 | [已核实：源码] |
| 会话事件增量 | `ctx.on('session/event', (session, event) => …)`，每提交一个事件触发一次；会话恢复时 seed 历史不重发，需要用 `readSession` 补读，按 `seq` 去重 | [已实测] |
| 会话快照 | `observeSession(id, { projectionMode: 'all' })` → `projections.values.{ workingDirectory, modelSelection, tokenUsage, contextPressure, todos, … }`，用完要 dispose | [已实测] |

**会话事件类型** [已核实：宿主包字符串，sel 的 transcript.js]：

- `user/message`（`data.content`）
- `assistant/message`（`data.message.content`）
- `assistant/chunk`
- `assistant/attempt`：模型请求的重试尝试，包含 `turn`、`step`、`stream`
- `tool/call`（`name`、`arguments`）
- `tool/result`（`data.message.content`、`error`）
- `turn/end`
- `compaction/start`、`compaction/end`、`compaction/summary`、`compaction/prune`

**`turn/end.reason`** [已实测]：

- `{ kind: 'completed' }`：正常结束
- `{ kind: 'error', error: { message, code, status? } }`
- `{ kind: 'aborted', reason }`：`reason.kind === 'user'` 表示用户取消
- `max-tokens`、`blocked`、`interrupted`、`forked`

**工具事件** [已实测]：

- `tool/call { turn, step, callId, name, arguments: <JSON 字符串> }`
- `tool/result { turn, step, message: { isError, content }, meta? }`
  - `write` 的 `meta` 为 `{ operation: 'create' | …, path: <绝对路径> }`。
  - `bash` 命令非零退出时 `isError` 仍为 `false`，失败只体现在结果文本末尾的 `[exit code: N]`。
- `job/settled.detail` 中有 `"exit code: N"`。

**重试事件** [已实测]：每次重试依次写入 `llm/retry { retry: n }`、`llm/retry-started`、`assistant/attempt`。

**模型错误码 `LlmError.code`** [已核实：宿主包]：

- 网络与超时：`TRANSPORT`、`TIMEOUT`、`STREAM_CLOSED`、`EMPTY_RESPONSE`
- 账号：`ACCOUNT_SIGN_IN_REQUIRED`、`ACCOUNT_TOKEN_INVALID`
- 请求与响应：`INVALID_REQUEST`、`INVALID_RESPONSE`、`MALFORMED_RESPONSE`
- 模型：`UNKNOWN_MODEL`、`NO_ADAPTER`、`INVALID_MODEL_CONTEXT`
- 文档注释里还提到 `AUTH`、`RATE_LIMIT`、`SERVER`，由 adapter 动态生成。

**DeepSeek 接口实际返回的错误码** [已实测]：

| 情况 | 错误码 |
| --- | --- |
| 余额不足（402） | `QUOTA`（账号登录方式下为 `ACCOUNT_QUOTA`） |
| 401 | `AUTH` |
| 403 | `FORBIDDEN` |
| 429 | `RATE_LIMIT` |
| 5xx | `SERVER` |
| 上下文超长 | `CONTEXT_WINDOW_EXCEEDED` |
| 断网或断流 | `TRANSPORT` |
| 流空闲 300 秒 | `TIMEOUT` |
| 没有配置密钥 | `MISSING_CREDENTIAL` |

**可重试的错误码** [已实测]：`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`。主 AI 默认最多重试 5 次，退避 500 ms 起、最长 10 s，限流全程约 16 秒。插件自己调用 `llm.stream` 时**不会重试**。

**其他宿主事实**：

- 模型结束原因 `finish.kind` 的取值：`stop`、`max-tokens`、`length`、`tool-calls`、`error`、`aborted`、`timeout`。[已核实：宿主包]
- Agent 状态只有 `idle` 和 `running` 两种 [已实测]。等授权、等回答没有独立状态，要从 `approval/request`、`user-questions/request` 识别。

### 1.4 客户端扩展点

| 扩展点 | 用途 | 状态 |
| --- | --- | --- |
| `slots.register({ name: 'shell.overlay', id })` | 划词菜单、解释卡、侧栏不可用时的悬浮面板。整页一层，`z-index: 20` | [已实测] |
| `slots.register({ name: 'conversation.input.dock', id, order })` | props 中有 `sessionId`、`inputActions`（`setDraft`、`insertText`、`submit`……）、`input.draft`、`session.{ running, lastAgentError, promptError }`；也用来显示输入框上方的提示条 | [已实测] |
| `slots.register({ name: 'conversation.chat.assistant-actions', id, order })` | AI 回复下的「白话版」按钮。props 只有 `messageId`（和 `sessionId`），轮次要反查 | [已实测] |
| `sidebarRightTabs.register({ id, kind, title, guide })` + `slots.register({ name: 'sidebar.right.pane.tab', key: id })` | 右侧栏标签。正文 props 中有 `sessionId`、`inputActions`、`useTabInfo()`；`sidebarRight.openTab(kind)` 可以用代码打开 | [已实测] |
| **注册写法** | `conversation.*` 和 `shell.overlay` 要用 `{ id, order }`，用 `key` 不会渲染；侧栏正文用 `key = 标签类型 id`。用 `slots.inject(name, cb)` 等扩展点声明后再注册；`slots.spec(name)` 可以判断扩展点是否存在 | [已实测] |
| `sessions.binding(id).session.prompt(..., 'queue')` | 直接发消息 | 存在，**本插件不用**（D3） |
| DOM 锚点 | `[data-chat-flow]`（对话区）、`[data-composer-card]`（输入框，排除）、`data-chat-anchor-key`（消息锚点） | [已实测] 都存在。但只有 `data-chat-anchor-key` 有文档，其他两个**没有稳定性承诺**。宿主没有划词或右键扩展点 |
| 设置表单 | `plugins.bundle.config`、`plugins.row.config` | [已核实：sel]，各版本之间有变动 |

### 1.5 从参考插件得到的教训

- **采用 sel 的做法**：
  - 路由加插件前缀。
  - 用 `connection.requestRejection` 做准入。
  - 每个扩展点先检测再使用。
- **不学 easy 的做法**：
  - 不访问 `sessions.store` 这类私有结构。
  - 不删除、不改写会话文件。
  - 不在插件内部执行 `pnpm up` 自更新。
  - 不使用无前缀的路由。
- **宿主版本之间的接口变动是常态**：例如 `Session.events` 变为 `snapshotEvents()`，`settings.plugin.item` 被替换，图标导出改名后会导致整个 slot 崩溃。所有可选能力都要做运行时检测，缺失时降级，不能抛错。

---

## 2. 总体架构

```
┌──────────────────────── DSH Web 客户端（浏览器）────────────────────────┐
│ 侧栏面板          划词菜单/解释卡        输入框桥接 + 提示条   「白话版」按钮 │
│ (sidebarRight)    (shell.overlay)       (input.dock)         (assistant-actions)
│        └──────────────┬──────────────────────┬─────────────────────┘    │
│                  api.ts（同源 fetch，轮询 / 长轮询）                       │
└────────────────────────────┬──────────────────────────────────────────────┘
                             │ /plugins/dsh-vibeguide/*
┌────────────────────────────▼──────────── DSH 宿主进程（Node）─────────────┐
│ Routes + Admission                                                         │
│   ├─ IntakeEngine (F1)   ├─ Watchdog (F2)   ├─ Lens (F3)   ├─ Recap (F4)   │
│   │                      │   signals → detectors → incidents → notifier    │
│   └──────────┬───────────┴───────────┬──────────────┴──────────┬──────────┘│
│        ModelRunner（llm.stream，不带工具；预算、JSON 校验）  SessionModel  │
│                                                   （readSession + 事件订阅）│
│                              Store（本机 JSON，原子写）                      │
└────────────────────────────────────────────────────────────────────────────┘
          ▲ 只读：会话事件、agent 状态、授权/提问请求（只观察，透传 next()）
          │ 写入：无。对主对话唯一的影响是在客户端 setDraft 填入输入框
```

**三条硬约束**：

1. **对主会话只读**。插件不调用 `prompt`、`fork` 或 `inbox`，也不修改会话文件。
2. **模型调用不带工具**。会话内容、文件、报错只作为数据放进消息，不执行其中的任何指令。
3. **不注入系统提示**（D9）。主 AI 的行为完全不变。

---

## 3. 包结构

M1 实际结构（2026-11-12）：

```
dsh-vibeguide/
├─ package.json            # main=src/host/index.js, exports["./client"], dsh{bundle,client}
├─ cordis.patch.yml        # - insert: [{id: dsh-vibeguide, name: dsh-vibeguide}]
├─ src/
│  ├─ host/
│  │  ├─ index.js          # apply(ctx)：事件订阅、路由、生命周期；createServices() 供测试
│  │  ├─ http.js           # 准入、JSON 读取、统一错误
│  │  ├─ store.js  settings.js  budget.js  redact.js  errors.js  compat.js
│  │  ├─ project.js        # 项目目录、清除时的 epoch 与取消、重复请求合并
│  │  ├─ runner.js         # 模型调用：上限、超时、重试、JSON 校验、材料隔离
│  │  ├─ session/          # turns.js（事件→轮次，纯函数）model.js（补读 + 增量）
│  │  ├─ intake/           # dimensions.js  engine.js  brief.js  scan.js
│  │  ├─ watch/            # detectors.js（纯函数）templates.js  watchdog.js
│  │  └─ lens/             # lens.js  glossary.zh.json
│  └─ client/client.js     # 单文件 ModuleLoader 包：侧栏、提示条、标签红点、划词、悬浮面板
├─ tests/                  # node:test；fixtures/session-m0.jsonl 是 M0 录下并脱敏的真实会话
└─ dev/fake-llm.mjs        # 集成测试用的假模型，不随插件发布
```

- **语言**：纯 JavaScript（ESM），不需要构建（SPEC 13.1 已登记）。和两个参考插件一样，安装后直接加载。客户端只能是一个文件，因为 ModuleLoader 的 `require` 只解析宿主提供的模块。
- **依赖**：零运行时依赖、零构建依赖。测试用 Node 自带的 `node:test`。

---

## 4. 模块设计

### 4.1 SessionModel：把会话事件整理成"轮次"

所有功能都基于同一个规范化模型，不直接解析原始事件：

```ts
type Turn = {
  index: number;
  userText: string;                 // 本轮触发的用户消息（source.kind === 'user'）
  steps: Step[];
  assistantText: string;            // 本轮最后一条 AI 回复的纯文本
  end?: { kind: 'stop' | 'error' | 'aborted' | 'max-tokens' | string;
          error?: { code: string; message: string } };
  attempts: number;                 // assistant/attempt 次数（重试）
  compacted: boolean;               // 本轮内是否发生过 compaction
  startedAt?: number; endedAt?: number;
};
type Step = { callId: string; tool: string; args: unknown;
  kind: 'read' | 'write' | 'exec' | 'other';   // 按工具名和参数形状归类
  paths: string[]; command?: string;
  result?: { ok: boolean; text: string; exitCode?: number }; seq: number; at?: number };
```

- **全量**：`readSession(id)` 取得全部事件，再按 `turn/end` 切分成轮次。
- **增量**：`ctx.on('session/event', (session, event))` [已实测]，按会话维护 `seq` 游标。插件启动或会话恢复时，先用 `readSession` 补读游标之后的事件，因为 seed 历史不会重发。订阅失效时，降级为每 2 秒读一次正在运行的会话。
- **工具归类** [已实测]：
  - 读：`read`、`read_image`、`glob`、`grep`。
  - 写：`write`、`edit`，路径在参数 `file_path`。`write` 的结果 `meta.operation` / `meta.path` 给出操作类型和绝对路径。
  - 执行：`bash`（Windows 为 `pwsh`），命令在参数 `command`。结果 `ok` 的判定要解析文本末尾的 `[exit code: N]`，不能只看 `isError`。
  - 其他工具：`todo_write`、`ask_user_question`、`web_*`、`subagent` 等，都归为 `other`。
  - 不认识的工具名，按参数形状兜底：有 `file_path` 和 `content` 的算写入，有 `command` 的算执行。
- **项目标识**：会话工作目录 realpath 后的 sha256（D12：项目按文件夹区分）。同一个文件夹里的所有会话共用简报、路线卡和总览。工作目录取 `projections.values.workingDirectory ?? session.cwd`，与宿主自身的做法一致 [已实测]。
- 只读取最近 N 轮（默认 30 轮或 2 MB），超出部分标记为"更早的记录未读取"。

### 4.2 IntakeEngine（F1 需求梳理）

#### 状态机

```
idle → idea → grounding → asking(round n) ⇄ (answer) → restating → brief_ready → filled
                              └──「先这样，开做」──────────▶ restating
```

#### 已有简报时的「新想法」

`/intake/start` 发现当前项目已经有简报时，先返回 `needsKind`，由客户端让用户选择：

- **新需求**：以最新版简报的维度状态作为初始状态（`known`），只对这次想法涉及的维度重新判断，确认后生成简报的新版本。
- **新项目**：客户端提示建议换一个文件夹。用户坚持在原文件夹时，生成新的简报系列，旧简报保留但不再作为当前目标。路线总览仍然按文件夹累积，并在总览里按简报系列分组显示。

#### 维度定义（`dimensions.ts`）

```ts
type Dimension = {
  id: 'goal_users' | 'core_flow' | 'data_source' | 'storage_visibility' | 'scope_v1'
    | 'usage_mode' | 'external_services' | 'done_criteria' | 'style';
  weight: 3 | 2 | 1;               // 影响度：高、中、低
  dependsOn: Dimension['id'][];    // 前置依赖，例如 storage_visibility 依赖 goal_users
  defaultable: boolean;            // 能否用推荐默认值直接标为"暂定"
};
type DimState = { id: Dimension['id'];
  status: 'known' | 'inferred' | 'defaulted' | 'unknown';
  value?: string; evidence?: string; confidence: number /* 0–1 */ };
```

#### 每轮的计算

1. **整理状态（模型）**：把想法、所有问答记录、grounding 事实和当前各维度状态交给模型，输出更新后的 `DimState[]` 和候选问题。
2. **选题（服务端，确定性规则）**：
   - 可问集合：状态为 `unknown`、前置依赖都已确定、而且没问过的维度。
   - 打分：`score = weight × (1 − confidence) × (1 + 被它阻塞的维度数)`。
   - 取分数最高的 k 题，`k = min(3, 可问集合中 weight ≥ 2 的数量)`。如果最高分的那题远高于其他，只问 1 题。
3. **停止条件**（满足任意一条就进入复述）：
   - 所有 `weight ≥ 2` 的维度都不再是 `unknown`。
   - 用户点了「先这样，开做」。
   - 累计问到 8 题：提示用户，由用户选择继续或开做。
   - 累计问到 12 题：强制停止。
4. **默认填充**：如果一个可默认的维度在停止时仍是 `unknown`，就采用推荐项，标为 `defaulted`。

#### 模型输出约束

服务端逐条校验模型给出的题目，不合格就丢弃：

```ts
type Question = { dim: Dimension['id']; text: string;          // ≤ 40 字，不含技术术语
  options: { label: string; consequence: string; recommended?: boolean }[]; // 2–4 个，恰好 1 个推荐
  allowFree: true; allowDelegate: true };
```

- 校验内容：选项数量；推荐项恰好一个；每个选项都有后果说明；题目不在术语黑名单上（例如出现"数据库""API""框架"时，必须换成后果来问）。
- 一轮中合格的题少于 1 道时，重试一次。重试仍失败，就直接进入复述。

#### Grounding（先自己查）

- 如果会话工作目录非空，做一次有上限的扫描：根目录文件列表、`package.json`、`README*`、入口页面的前 2 KB。上限是 40 个文件或 200 KB。
- 扫描结果交给模型，用来把维度标为 `inferred`，例如"已有 React 项目""已有登录页"。只扫描，不执行任何东西。

#### 生成简报

- 复述（模型）：输出"我理解你要做的是……"，100 字以内。用户可以确认，也可以改其中一句；改动作为新答案进入下一次计算。
- 简报（模型 + 模板）：模型输出结构化字段，服务端按 PRD 6.5 的模板渲染成文本。最后一段"给你的工作方式"是固定模板，不由模型生成，保证每次都带上对主 AI 的约束。

```ts
type Brief = { id: string; projectId: string; version: number; title: string;
  oneLiner: string; users: string; coreFlow: string; inScope: string[]; outOfScope: string[];
  data: string; usage: string; doneCriteria: string[];
  confirmed: string[]; tentative: string[]; createdAt: string; text: string /* 渲染后的全文 */ };
```

- **成本**：每轮 1 次模型调用，复述 1 次，简报 1 次。典型流程（2–3 轮）共 4–5 次。

### 4.3 Watchdog（F2 异常预警）

#### 流水线

```
信号源 ──▶ 检测器（纯函数，按信号触发）──▶ 事件聚合（去重、计数、自动恢复）──▶ 解释器（模板优先，否则模型）──▶ 通知
```

#### 信号源

| 信号 | 来源 |
| --- | --- |
| 轮次结束 | `turn/end.reason`，含 `kind`、`error.code`、`error.message` |
| 重试 | `assistant/attempt` 的次数 |
| Agent 状态与错误 | `agent/status`、`agent/error` |
| 工具执行 | `tool/call`、`tool/result`（`error`、输出文本、退出码） |
| 授权与提问 | `approval/request`、`user-questions/request`。只记录，然后立即 `return next()` |
| 上下文压缩 | `compaction/*` |
| 用户消息 | `user/message` 的文本 |
| 时钟 | 状态为 `running` 时，距离最后一个事件的时长 |
| 客户端 | `navigator.onLine`、页面与宿主的连接状态（由客户端上报） |

#### 检测器清单

编号对应 PRD 7.2 的表格。

| ID | 规则 | 级别 | 解释来源 |
| --- | --- | --- | --- |
| A1 断网 | `turn/end.error.code = TRANSPORT`（宿主已重试 5 次）；或客户端报告离线 [已实测] | 阻断 | 模板 |
| A2 正在重试 | 收到 `llm/retry { retry: n }` 事件，第一次重试就能看到 [已实测]；显示"正在重试 (n/5)"，并按 `error.code` 说明原因 | 提示，失败后升级 | 模板 |
| A3 限流 | `code = RATE_LIMIT` [已实测] | 阻断 | 模板 |
| A4 额度不足 | `code ∈ {QUOTA, ACCOUNT_QUOTA}` [已实测]；兜底匹配 `402`、`insufficient balance`、`余额不足` | 阻断 | 模板 |
| A5 登录失效 | `code ∈ {AUTH, FORBIDDEN, MISSING_CREDENTIAL, ACCOUNT_SIGN_IN_REQUIRED, ACCOUNT_TOKEN_INVALID}` [已实测部分] | 阻断 | 模板 |
| A6 服务故障 | `code = SERVER` [已实测] | 阻断 | 模板 |
| A7 超时 | `code = TIMEOUT`。宿主要等 300 秒无数据才判定，用户早就看不到进展了，所以主要靠 C8 | 阻断 | 模板 |
| A8 回复为空或断流 | `code ∈ {EMPTY_RESPONSE, STREAM_CLOSED, MALFORMED_RESPONSE}`。断流实测归入 `TRANSPORT`，由 A1 处理 | 阻断 | 模板 |
| A9 对话太长 | `code = CONTEXT_WINDOW_EXCEEDED` [已实测]；或 `projections.values.contextPressure` 接近上限时提前提示 | 阻断 | 模板 |
| A10 回复被截断 | `turn/end.reason.kind = max-tokens` [已实测] | 注意 | 模板 |
| B1 缺依赖 | `bash` 结果为 `[exit code: 127]`，或文本匹配 `command not found`、`Cannot find module`、`ModuleNotFoundError`、`No module named`、`is not recognized` [已实测] | 注意 | 模板 |
| B2 端口被占 | 匹配 `EADDRINUSE`、`address already in use` | 注意 | 模板 |
| B3 没有权限 | 匹配 `EACCES`、`EPERM`、`permission denied`，或宿主拒绝授权 | 注意 | 模板 |
| B4 找不到文件 | 匹配 `ENOENT`、`No such file` | 提示，连续 2 次升级为注意 | 模板 |
| B5 下载失败 | 匹配 `ETIMEDOUT`、`ECONNRESET`、`ENOTFOUND`、`npm ERR! network`、`Could not resolve host`，并且命令是安装类 | 注意 | 模板 |
| B6 反复失败 | 同一个命令签名（去掉路径和数字后取哈希）在 2 轮内连续失败 ≥ 3 次 | 注意 | 模板 + 安全词 |
| C1 原地打转 | 同一轮内，相同的（工具 + 规范化参数）哈希出现 ≥ 3 次；或者同一文件被写入 ≥ 4 次，且中间夹着失败 | 注意 | 模板 + 安全词 |
| C2 思路偏移 | TurnAnalysis（见 4.5）返回 `drift`，并附依据 | 注意 | 模型 |
| C3 范围蔓延 | TurnAnalysis 返回 `scopeCreep`。预过滤：新增依赖，或改动文件数超过近 5 轮中位数的 3 倍 | 注意 | 模型 |
| C4 空口完成 | 预过滤：AI 回复中含"完成/通过/已修复/测试通过"，且本轮没有执行类步骤，或执行失败。由 TurnAnalysis 确认 | 注意 | 模型 |
| C5 动了不该动的 | TurnAnalysis 返回 `constraintViolation`，对照简报的"不做"和用户说过的"不要……" | 注意 | 模型 |
| C6 让用户自己操作 | AI 回复中含 shell 代码块，并且出现"请运行/在终端/你需要执行" | 提示 | 模板 + F3 |
| C7 可能遗忘 | 出现 `compaction/end`，且简报存在 | 提示 | 模板（附"重新对齐"安全词） |
| C8 长时间没动静 | 插件自己计时：`agent/status = running` 期间 180 秒没有新的 `session/event`。宿主自己的 `TIMEOUT` 要 300 秒，不够及时 [已实测] | 注意 | 模板 |
| C9 中途停下 | TurnAnalysis 返回 `unfinished`；或者 `turn/end = aborted` 且 `reason.kind ≠ 'user'`；或者 `turn/end = interrupted` | 注意 | 模型或模板 |
| D1 等授权 | `approval/request` 监听（只观察，`return next()`），或会话事件 `approval/asked` 之后 30 秒没有 `approval/decided`。`agent/status` 没有"等授权"状态 [已实测] | 注意 | 模板 + 模型解释授权内容（可选） |
| D2 等回答 | 收到 `user-questions/request` 后 60 秒仍未作答 | 提示 | 模板 |
| E1 连续不满 | 最近 3 条用户消息中，有 ≥ 2 条匹配不满词表（还是不行、又错了、怎么还、没用、不对） | 注意 | 模板 + 安全词 |
| X 不认识的报错 | 出现 `error` 或失败的 `tool/result`，但没有命中任何模板 | 注意 | 模型 |

#### 异常事件模型

```ts
type Incident = { id: string; sessionId: string; projectId: string; detector: string;
  severity: 'block' | 'warn' | 'info'; state: 'open' | 'recovered' | 'dismissed';
  firstSeq: number; lastSeq: number; count: number;
  evidence: { seq: number; excerpt: string }[];          // 已脱敏，每条 ≤ 600 字
  explanation?: { what: string; why: string; impact: string; guessed: boolean };
  actions: Action[]; feedback?: 'wrong' | 'helpful' };
type Action =
  | { kind: 'fill'; label: string; text: string }        // 填入输入框
  | { kind: 'steps'; label: string; steps: string[] }    // 用户自己操作
  | { kind: 'safeword'; id: string };
```

- **去重键**：`detector + sessionId + 签名`。签名例如错误码或命令哈希。在开启状态下重复出现只增加 `count`。
- **自动恢复**：
  - A 类：之后出现成功的 `assistant/message` 时恢复。
  - B6、C1：之后同一个签名执行成功时恢复。
  - D 类：请求被处理后恢复。
- **冷却**：同一个检测器对同一会话 10 分钟内最多打开 1 个异常，B6 和 C1 除外。
- 修复指令的模板变量（例如 `{port}`、`{briefItem}`）在服务端填好。填不出来的模板不显示，保证填入的文字里没有占位符。

#### 通知

- 客户端订阅 `GET /watch/stream?sessionId=`（SSE，`webServer` handler 可以分段写，已实测）。连接断开时，退回每 2 秒轮询一次 `GET /watch/state`。
- 命令失败统一按结果文本末尾的 `[exit code: N]` 判定（N ≠ 0 即失败）；`isError` 只表示命令没能启动或被中止 [已实测]。
- `block` 级异常在侧栏关着时，由 `conversation.input.dock` 渲染提示条。

### 4.4 Lens（F3 划词解释）

**客户端** [参照 sel 已核实的做法]：

- 在 `pointerup`、`selectionchange`、`keydown` 时读取当前选区。选区必须在 `[data-chat-flow]` 内，并且不在 `[data-composer-card]`、输入控件中。
- 用 `getRangeAt(0).getBoundingClientRect()` 定位。菜单和解释卡挂在 `shell.overlay` 里，滚动或 Esc 时关闭。
- 记录选区所在消息的 `data-chat-anchor-key`，供宿主端定位上下文。
- 选中文字 2–2000 字才显示菜单。

**选中内容分类**（客户端预判，服务端最终确定）：

| 类型 | 判断条件 |
| --- | --- |
| `term` | 不超过 24 字，且不含句末标点 |
| `error` | 命中 B 类检测器的匹配模式，或者是堆栈格式 |
| `passage` | 超过 200 字 |
| `sentence` | 其余情况 |

**宿主端 `POST /lens/explain`**：

1. `term` 先查本地词库 `glossary.zh.json`（首批约 100 条通用术语，D14；字段：`term`、`aliases`、`what`、`analogy?`、`whenItMatters`），命中就立即返回 `what`。没有命中的选中词，在本机按次数累计（只记词，不记上下文）。设置页可以导出这份统计，用来决定下一批补充哪些词条。
2. 组装上下文：
   - 选区所在的消息：能用锚点定位就用锚点，否则取最近一条包含该文字的消息。
   - 最近 6 轮的摘录：用户消息、AI 回复、工具名和结果摘要，总共不超过 12k 字。
   - 当前简报的一句话目标和范围。
3. 调用模型，输出 `{ what, inYourProject, needAction: 'none' | 'decide' | 'do', actionHint?, techName? }`。`what` 要先于其他字段显示给用户（流式解析，或分两段输出），保证 3 秒内出现第一段可读内容（Spec F3-10）。
4. 缓存键为 `sessionId + 规范化选区 + 上下文摘要哈希`，保留 24 小时。
5. `error` 类型改由 Watchdog 的解释器处理，输出与预警卡相同的格式。

**`POST /lens/ask`**：在侧栏里多轮追问。

- 线程保存在宿主端，按会话保存，最多 50 条。
- 每次带上引用、线程最近 6 条和与上面相同的上下文。
- 与 sel 不同，这里要支持多轮：用户追问"那换电脑怎么办"时，需要知道前文。

### 4.5 Recap（F4 白话路线）与 TurnAnalysis

**触发**：

- `turn/end` 且不是 error 或 aborted，并且本轮至少有 1 个 `write` 或 `exec` 步骤。
- 用户手动点「白话版」，此时生成指定的那一轮，即使本轮没有改动。

**证据提取**（确定性规则，不调用模型）：

```ts
type TurnEvidence = { userText: string; assistantClaims: string[];   // AI 回复里含"完成/通过/已…"的句子
  writes: { path: string; op: 'create' | 'edit' | 'delete' }[];
  execs: { command: string; ok: boolean; exitCode?: number; isCheck: boolean }[];  // isCheck：test/build/lint 等
  newDeps: string[];                                                 // 由安装命令或 package 清单的写入推断
  briefItems: { id: string; text: string; kind: 'in' | 'out' | 'done' | 'constraint' }[];
  userConstraints: string[] };                                       // 用户消息中"不要/别/只/必须…"的句子
```

**一次模型调用同时产出路线卡和 C 类判断**：

```ts
type TurnAnalysis = {
  recap: { title: string;
    steps: { did: string; meansForYou: string; techTerms: string[]; evidence: string[] }[];  // 3–6 步
    tryNow: string[]; briefProgress: { itemId: string; state: 'done' | 'partial' | 'todo' }[];
    notDone: string[]; unverifiedClaims: string[] };
  flags: { kind: 'drift' | 'scopeCreep' | 'unverifiedCompletion' | 'constraintViolation' | 'unfinished';
           detail: string; evidence: string[]; confidence: number }[] };
```

**服务端校验**：

- 每一步的 `evidence` 必须能对应到 `TurnEvidence` 里的路径或命令，否则删掉这一步。删完后不足 3 步时，用证据直接生成通用描述补齐。
- `flags` 只保留 `confidence ≥ 0.6` 且带证据的，然后交给 Watchdog 生成 C 类异常。
- `unverifiedClaims` 由服务端再核对一次：如果说了"测试通过"，本轮必须有 `isCheck` 为真且成功的执行记录，否则保留在列表中。

**路线总览**：

- 按项目追加保存 `RecapCard[]`。
- 简报进度取每个条目的最新状态。
- 导出时用 Markdown 模板渲染。
- 「填入新会话」生成"项目接续摘要"：简报全文 + 已完成条目 + 未完成条目 + 最近 3 张路线卡的标题。上限 1500 字。

**成本**：每个有改动的轮次 1 次调用，手动触发也是 1 次。受每轮上限和"自动分析每轮任务"开关控制。这个开关默认开启（D11）。第一张自动生成的路线卡带 `costNotice: true`，客户端据此显示一行额度说明，显示后在 `settings.json` 里记下已提示，以后不再显示。

**只在轮次结束时分析**（D13）：执行过程中不调用模型做偏移检查，所以 C2–C5 的预警最早在这一轮结束时出现。执行中的问题由规则类检测器实时覆盖，包括 B6 反复失败、C1 原地打转、C8 长时间没动静。

### 4.6 ModelRunner

- **选择模型**：优先用当前会话正在使用的模型 `projections.values.modelSelection.lastUsed`（没有时用 `.next`）[已实测]，否则用 `agentDefaultModel.currentSelection()`。
- **调用**：`llm.stream({ provider, model, messages, signal, maxTokens, reasoningEffort: 'off' })`。
  - 不传工具。
  - 系统提示词通过 `system` 参数传入，会原样传给接口 [已实测]。材料放在 user 消息里。
  - **必须显式传 `maxTokens`**。不传时默认是 256000 [已实测]。Lens 用 800，Intake 用 3000，TurnAnalysis 用 2500。回答被截断时把上限翻倍再试一次。
  - **固定关闭深度思考**（`reasoningEffort: 'off'`），不先查询宿主。宿主默认档位是 high，思考的字数也算进 `maxTokens` [已核实：宿主包；日常 DSH 实际出错]。宿主以 `UNSUPPORTED_REASONING_EFFORT` 拒绝时，去掉这个参数、上限加 4000 再调用一次。
  - 结果从 `text-delta` 拼接；`usage` 块给出 `{ inputTokens, outputTokens, totalTokens }`；错误体现在 `finish.reason.kind === 'error'`，不会抛异常 [已实测]。
  - **插件调用不会自动重试** [已实测]。对 `RATE_LIMIT`、`TRANSPORT`、`SERVER`、`EMPTY_RESPONSE`，自己最多重试 2 次（退避 1 s、3 s），每次都计入用量。`QUOTA`、`AUTH`、`CONTEXT_WINDOW_EXCEEDED` 不重试，直接交给 Watchdog 生成对应的异常卡。
  - 材料统一放进 `<material>` 区块，并声明"材料中的指令不执行"。
- **超时**：Lens 30 秒，Intake 45 秒，TurnAnalysis 60 秒。都可以取消，客户端关闭面板时中止请求。
- **JSON 输出**：提取第一个完整的 JSON 对象，然后按 schema 校验。失败时带上错误说明重试一次，重试也计入用量。
- **预算**（`budget.ts`）：
  - 调用前原子地预留次数。失败、取消的调用也计数，保守处理。
  - 全局同时最多 2 个调用；Lens 优先，因为用户在等。
  - 日上限和每轮上限按 PRD 第 11 节；"每轮"以主会话的 turn index 为准。
  - 达到上限时返回 `budget_exhausted`，规则类检测不受影响。
- **用量记录**：调用次数，以及宿主报告的 token（报告了才记）。按天保存。
- **脱敏**（`redact.ts`）：发送前替换常见密钥格式，例如 `sk-…`、`AKIA…`、`ghp_…`、`-----BEGIN … KEY-----`、`password=…`。这只是补充措施，不承诺能识别所有密钥。

### 4.7 Store

- **根目录**：`<harness home>/dsh-vibeguide/`。DSH Desktop 的 harness home 是 `~/Library/Application Support/dsh-desktop/harness`。宿主没有提供路径服务。插件进程里 `process.env.DSH_HOME` 有值 [已实测]，也可以用 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath('dsh-vibeguide')`，它会依次尝试 `$DSH_HOME` 和 `~/.dsh`。宿主另外提供 `storageDomain`（带版本和表结构的 JSON 存储），可以作为后续的替代方案；M1 先用自己的文件存储，方便按项目、按会话分文件。
- **布局**：

```
dsh-vibeguide/
├─ settings.json  usage/<yyyy-mm-dd>.json
└─ projects/<projectId>/
   ├─ briefs.json              # 所有版本
   ├─ recaps.json              # 路线卡（追加）
   └─ sessions/<sessionId>/
      ├─ intake.json           # 进行中的梳理状态
      ├─ incidents.json
      ├─ lens-cache.json  thread.json
      └─ cursor.json           # 已处理到的事件序号
```

- **写入方式**：写到临时文件，fsync，再 rename。同一个文件的写入由进程内的队列串行化。
- **容量**：单个文件不超过 4 MB，`recaps` 超过上限时归档到 `recaps-<n>.json`，`lens-cache` 按 LRU 淘汰。
- **损坏处理**：读取失败时把原文件改名为 `.corrupt-<ts>` 保留，然后从空状态开始，并在侧栏提示。

---

## 5. HTTP 接口

前缀：`/plugins/dsh-vibeguide`。

所有接口都要求：

1. `connection.requestRejection(req)` 为空，否则按它返回的 401/403 结束请求。**宿主不会替插件接口做校验**，必须在每个 handler 里自己调用。实测：页面发出的请求带签名 cookie，返回空（放行）；不带 cookie 返回 401；外部 Origin 返回 403。如果这个能力不存在，就要求请求来自 loopback，`Origin` 与 `Host` 同源，并且带 `Sec-Fetch-Site: same-origin`。
2. 写操作要求 `Content-Type: application/json`。
3. 请求体不超过 256 KB。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/state?sessionId=` | 侧栏首屏：项目名、状态、开启中的异常、最新简报和路线卡摘要、用量 |
| POST | `/intake/start` | `{ sessionId, idea, scenario?, kind?: 'revise' \| 'new' }` → 第一轮题目，或 grounding 后直接进入复述；项目已有简报而没传 `kind` 时，返回 `{ needsKind: true }` |
| POST | `/intake/answer` | `{ sessionId, answers: [{ dim, choice \| free \| delegate }] }` → 下一轮题目或复述 |
| POST | `/intake/skip` | 「先这样，开做」 |
| POST | `/intake/confirm` | `{ sessionId, restateEdits? }` → `Brief` |
| PUT | `/brief` | 用户编辑简报，生成新版本 |
| GET | `/watch/stream?sessionId=` | SSE 推送异常的开启、更新和恢复（主通道） |
| GET | `/watch/state?sessionId=&since=` | 增量返回异常和恢复情况（SSE 断开时的兜底） |
| POST | `/watch/client-signal` | 客户端上报离线、重连等信号 |
| POST | `/watch/feedback` | `{ incidentId, kind: 'dismiss' \| 'mute' \| 'wrong' \| 'helpful' }` |
| POST | `/lens/explain` | `{ sessionId, text, anchorKey?, kind? }` |
| POST | `/lens/ask` | `{ sessionId, quote?, question }` |
| POST | `/recap/generate` | `{ sessionId, turnIndex }`，手动「白话版」 |
| GET | `/recap/overview?sessionId=` | 路线总览 |
| GET | `/recap/export?sessionId=` | Markdown 全文 |
| GET | `/handoff?sessionId=` | 「填入新会话」用的接续摘要 |
| GET/PUT | `/settings` | 设置 |

- **错误格式**：`{ error: { code, message } }`。`message` 是给用户看的中文。

| code | 含义 |
| --- | --- |
| `budget_exhausted` | 达到调用上限 |
| `model_unavailable` | 没有可用模型 |
| `context_too_large` | 材料超过上限 |
| `session_not_found` | 找不到会话 |
| `invalid_output` | 模型输出未通过校验 |
| `unsupported_host` | 宿主版本不支持 |

---

## 6. 客户端

- **入口**（`client/index.tsx`）：依次检测各个扩展点，存在就注册；任何一个注册失败都只记日志，不影响其他功能。
  - `factory` 返回的 `inject` 只写 `['slots']`。
  - 其他服务（`sidebarRightTabs`、`sidebarRight`、`sessions`）都用 `ctx.inject([name], cb)` 按需获取 [已实测]：只用 `ctx.get` 会在服务就绪前拿到空值。
  - `require` 只能解析宿主提供的模块：`react`、`react-dom`、`zod`、`dsh-client-store`、`dsh-client-ui-slots` 等，其余依赖一律打包进来。
- **输入框桥接**（`bridge/input.ts`）：
  - 在 `conversation.input.dock` 里挂一个不可见组件，按 `sessionId` 保存 `inputActions`。
  - `fill(sessionId, text)` 的流程：
    1. 用 `props.useInput(s => s.draft)` 读取当前草稿 [已实测]。
    2. 如果草稿非空，询问"替换还是追加"。
    3. 调用 `setDraft`。
    4. 聚焦输入框。没有公开的 focus 方法，先找 `[data-composer-card] textarea` 并聚焦；找不到时只填入、不聚焦。
  - 失败时调用 `navigator.clipboard.writeText` 并提示用户。
  - 绝不调用 `submit()` 或 `prompt()`。
- **侧栏** [已实测]：
  - 用 `ctx.inject(['sidebarRightTabs'], …)` 注册标签类型 `{ id: 'dsh-vibeguide/panel', kind: 'vibeguide', title, guide: [{ id, title, description }] }`，正文注册在 `sidebar.right.pane.tab`，`key` 等于这个 id。
  - 预警需要时，通过 `sidebarRight.openTab('vibeguide')` 打开侧栏。
  - 侧栏正文的 props 里也有 `inputActions`，所以侧栏内的"填入"可以直接调用，不必经过输入框桥接。
  - 侧栏是按会话的，没有会话的首页不显示。F1 的"新会话默认打开"要等首页创建出会话之后才能触发。
  - `sidebarRightTabs` 不存在时，在 `shell.overlay` 里放一个可拖动、可收起的悬浮面板，内容相同。
- **白话版按钮** [已实测]：在 `conversation.chat.assistant-actions` 里渲染，注册时用 `{ id, order }`。props 里只有 `messageId`。点击后把 `messageId` 发给宿主端，宿主端在 `readSession` 里找到 `assistant/message.data.message.id` 对应的那一条，取它的 `turn`。
- **客户端即时状态**：会话类扩展点的 props 里有 `session.{ running, lastAgentError, promptError }`。客户端可以据此马上显示 A 类异常，不必等宿主端推送。
- **样式**：使用宿主的 CSS 变量（参照 sel 用的 `--dsw-alias-*`），自动适配深色模式。所有类名加 `vg-` 前缀，避免和其他插件冲突（所有插件同源，没有隔离）。
- **图标**：自带 SVG，不依赖宿主的图标导出，避免宿主改名后崩溃。

---

## 7. 兼容性与降级

| 缺失的能力 | 降级方式 |
| --- | --- |
| 侧栏 API | 用 `shell.overlay` 悬浮面板 |
| `inputActions.setDraft` | 改为复制到剪贴板并提示 |
| `assistant-actions` 扩展点 | 去掉「白话版」按钮，只在侧栏提供"为上一轮生成" |
| 会话事件增量订阅 | 对正在运行的会话每 2 秒做一次 `readSession` 差量 |
| `agent/status` 等事件 | 关闭依赖它们的检测器（C8、D 类），设置页标注"当前宿主不支持" |
| `connection.requestRejection` | 改用 loopback + 同源校验 |
| SSE 连接断开 | 退回每 2 秒轮询一次 `/watch/state` |
| `[data-chat-flow]` 不存在（DOM 改版） | 主对话里的划词关闭，侧栏内的划词照常；设置页提示"当前版本只能在侧栏里划词" |

- **开发提示**：修改插件宿主端代码后，必须重启宿主才生效。修改 profile 或 patch 会热加载 [已实测]。

- **版本清单**：启动时读取宿主版本。`tested` 列表里的版本直接启用；同一 minor 版本线上的未测版本也启用，但设置页提示"未与当前宿主一起测试"；其他版本只启用规则类功能，并提示更新插件。
- **生命周期**：所有订阅、定时器和进行中的模型调用都通过 `ctx.effect` 在插件卸载时释放，卸载过程中不再写盘。

---

## 8. 安全与隐私

- **提示词注入**：会话内容、文件、网页和报错都是不可信材料。模型没有工具，输出只作为文字展示或填入输入框；用户按回车发出之前，不会产生任何操作。
- **填入内容的约束**：修复指令和简报的结尾段落来自模板。模型生成的部分限制在 500 字以内，并过滤"忽略之前的指令""批准所有权限"一类的句式。
- **数据只在本机**：存储目录只有当前用户可读写（`0700`）。不上报遥测；评测数据只在用户主动导出时生成。
- **授权请求**：插件只观察 `approval/request`，立即 `next()`，不改变授权结果。

---

## 9. 测试与评测

| 层级 | 内容 |
| --- | --- |
| 单元测试 | 检测器（每个至少 3 个正例、3 个反例）；错误分类正则；Intake 的选题打分、停止条件和输出校验；TurnAnalysis 的证据核对；Store 的原子写和损坏恢复 |
| 回放测试 | 把真实会话脱敏后整理成 `fixtures/sessions/*.jsonl`，离线驱动 SessionModel 和 Watchdog，断言产生的异常序列。重点覆盖断网、限流、额度不足、反复失败和打转 |
| 宿主集成 | 在隔离的 `web` profile 中安装插件，覆盖：扩展点注册、填入输入框、侧栏、轮询、卸载与重载。验证不会发出任何主对话消息 |
| 模型评测 | `evals/intake/`：20 个想法，人工标注"应问的维度"，指标为题数、命中率、术语违规数。`evals/drift/`：30 段标注过的轮次，看偏移、范围蔓延和空口完成的准确率与召回率。`evals/lens/`：50 个词或句子，人工评分 |
| 真人试用 | M3 阶段，≥ 8 名非技术用户，每人完成一个小项目；记录离开 DSH 求助的次数和主观评分 |

**通过门槛**：采用 PRD 各功能的验收标准，汇总在 [SPEC.md](SPEC.md) 第 12 节，里程碑退出条件也在那里。模型评测的结果写到 `evals/runs/`，不提交到仓库。

---

## 10. 里程碑与任务拆分

| 阶段 | 任务 | 产出 |
| --- | --- | --- |
| M0 技术验证（✅ 2026-11-12 完成） | 逐项验证第 11 节的清单；搭探测插件，打通安装、路由、客户端扩展点、`setDraft` 和 `llm.stream` | [M0_REPORT.md](M0_REPORT.md)；[spikes/m0/](../spikes/m0/) |
| M1（实现完成 2026-11-12，未退出，见 [M1_REPORT.md](M1_REPORT.md)） | SessionModel；Store；ModelRunner 和预算；IntakeEngine 和简报；Watchdog 的 A、B、D 类及模板；Lens 解释、追问和词库；侧栏骨架；设置 | 内部可试用版本；单元测试和回放测试 |
| M2（约 3 周） | TurnAnalysis；Recap 卡片、总览、导出和接续；Watchdog 的 C、E 类；白话版按钮 | 全功能版本；三套模型评测 |
| M3（约 2 周） | 真人试用；误报调优；文案；兼容性清单；发布说明 | 正式版本 |

---

## 11. M0 验证结果

详细过程和证据见 [M0_REPORT.md](M0_REPORT.md)。

| # | 问题 | 结果 |
| --- | --- | --- |
| V1 | 右侧栏注册 API | ✅ `sidebarRightTabs.register` + `sidebar.right.pane.tab`；`sidebarRight.openTab` |
| V2 | 填入输入框、读取草稿 | ✅ `inputActions.setDraft` 只填不发；`useInput(s => s.draft)` |
| V3 | AI 回复按钮能拿到什么 | ✅ 只有 `messageId`，轮次由宿主端反查 |
| V4 | 会话增量事件 | ✅ `session/event (session, event)`；seed 历史要补读 |
| V5 | cwd 和当前模型 | ✅ `projections.values.workingDirectory ?? session.cwd`；`modelSelection.lastUsed` |
| V6 | `llm.stream` 参数 | ✅ 支持 `system`、`maxTokens`、`usage`；必须传 `maxTokens`；不会自动重试 |
| V7 | 断网时的表现 | ✅ 重试 5 次后 `turn/end` 报错，错误码 `TRANSPORT`；重试过程有 `llm/retry` 事件 |
| V8 | 额度、限流等错误码 | ✅ `QUOTA`、`RATE_LIMIT`、`AUTH`、`FORBIDDEN`、`SERVER`、`CONTEXT_WINDOW_EXCEEDED`、`MISSING_CREDENTIAL` |
| V9 | 内置工具名 | ✅ `read`、`write`、`edit`、`bash`…；命令失败看 `[exit code: N]` |
| V10 | 轮次结束种类 | ✅ `completed`、`error`、`aborted{reason.kind}`、`max-tokens`、`blocked`、`interrupted` |
| V11 | SSE | ✅ 可用 |
| V12 | 数据目录 | ✅ `process.env.DSH_HOME` / `dshHomePath()` |
| V13 | 安装 | ⚠️ `dsh plugin --profile web add` 可用并会热加载；桌面版「添加插件」界面还没在你的日常应用里实测（M1 首个内部版本安装时补测） |

---

## 12. 风险

| 风险 | 应对 |
| --- | --- |
| 宿主接口在小版本间变化（参考插件已多次遇到） | 扩展点全部运行时检测；只使用公开服务和已核实的事件；维护版本清单；回放测试不依赖宿主 |
| 错误信息因模型供应商不同而不同，正则识别漏判 | 先用错误码，再用正则；未命中的交给模型解释（X 检测器）并记录，用于补充模板 |
| TurnAnalysis 自身产生幻觉 | 每一步都要能对应到证据；flag 需要置信度和证据；用户可标"提醒错了" |
| 轮询带来的性能开销 | 主通道改用 SSE（已实测可用）；轮询只在 SSE 断开时兜底 |
| 划词依赖没有文档的 DOM 属性（`data-chat-flow`） | 运行时检测，属性不存在时降级为只在侧栏内划词；每次宿主升级都把它加入回归检查 |
| 插件接口没有自动鉴权 | 每个 handler 第一行调用 `connection.requestRejection`，并用单元测试覆盖 401、403 和放行三种情况 |
| 与其他划词插件冲突（例如用户另装了 sel） | 检测到 sel 的 DOM 标记时，把"解释"作为附加入口，不再弹出我们自己的菜单 [待设计细节] |
