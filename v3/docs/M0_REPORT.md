# M0 技术验证报告

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-11-12 |
| 宿主 | DSH Desktop 内置 `@deepseek-ai/dsh` **0.2.1-rc.2**（profile `web`） |
| 对应文档 | [技术设计](TECH_DESIGN.md) 第 11 节 V1–V13 |
| 验证代码 | [spikes/m0/](../spikes/m0/)：探测插件 `probe/`、假模型服务 `fake-llm.mjs` |

## 结论

13 项全部有结论：11 项实测通过，2 项部分通过但有可行方案（见下表的 V13 和"新增发现"）。**没有发现阻断 v3 设计的问题。** 需要改设计的地方有 6 处，已同步到技术设计文档（见第 4 节）。

## 1. 验证方法

- **隔离宿主**：用 DSH Desktop 自带的运行环境，以临时 `DSH_HOME`（草稿目录）启动一个独立宿主，端口 17690。没有改动你日常使用的 DSH 配置。事后核对，日常 profile 里没有探测插件。
- **探测插件**：通过官方命令 `dsh plugin --profile web add link:<路径>` 安装。插件只读取、只记录：
  - 宿主端：订阅事件、读取会话、调用模型、测试 SSE。
  - 客户端：挂到各个扩展点，记录收到的 props。
- **假模型服务**：模拟 DeepSeek 接口，按脚本返回正常回复、工具调用、429、402、401、5xx、上下文超长、断流、截断，或者直接停掉服务来模拟断网。宿主通过 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_API_KEY` 环境变量连到它。
- **源码阅读**：从安装包解出宿主各包的中文 README 和代码，与实测结果互相核对。
- **测试残留**：隔离宿主会在 `~/Documents/deepseek-harness/default-workspace` 建默认工作区，测试中写入的 `weekly.html` 也落在那里。这个文件夹是测试当天新建的，已经清理。

## 2. 逐项结果

| # | 问题 | 结果 | 结论 |
| --- | --- | --- | --- |
| V1 | 右侧栏注册 | ✅ 实测 | `sidebarRightTabs.register({ id, kind, title, guide })` 注册标签类型，再用 `slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)` 注册正文；`sidebarRight.openTab(kind)` 可以用代码打开。正文 props 包含 `sessionId`、`inputActions`、`useTabInfo()`。侧栏是按会话的，没有会话的首页不显示侧栏。 |
| V2 | 填入输入框 | ✅ 实测 | `conversation.input.dock` 的 props 包含 `sessionId`、`inputActions`（`setDraft`、`insertText`、`submit`……）和 `input.draft`。`setDraft` 只填入，不发送，实测文字出现在输入框里且没有发出。读取草稿用 `useInput(s => s.draft)`。 |
| V3 | AI 回复下的按钮 | ✅ 实测 | `conversation.chat.assistant-actions` 正常渲染，props 里只有 `messageId`（和 `sessionId`），没有轮次号。轮次通过 `readSession` 里 `assistant/message.data.message.id` 反查。 |
| V4 | 会话事件增量 | ✅ 实测 | `ctx.on('session/event', (session, event) => …)`，每提交一个事件触发一次。注意：会话恢复时历史（seed）不会重发，需要用 `readSession` 补读，按 `seq` 去重。 |
| V5 | cwd 和当前模型 | ✅ 实测 | `readSession` 返回 `{ session, inheritedEventCount, events }`，`session.cwd` 是创建时的目录。`observeSession(id, { projectionMode: 'all' })` 的 `projections.values` 里有 `workingDirectory`（切换后的目录）和 `modelSelection.{ lastUsed, next }`。用完要 dispose。 |
| V6 | 插件单独调用模型 | ✅ 实测 | `llm.stream({ provider, model, messages, system, maxTokens, signal })` 中的 `system` 和 `maxTokens` 都会传给接口。块类型有 `block-start`、`text-delta`、`block-end`、`usage`、`finish`；用量为 `{ inputTokens, outputTokens, totalTokens }`。**不传 `maxTokens` 时默认是 256000**。报错不抛异常，而是体现在 `finish.reason = { kind: 'error', failure: { code, message, status } }`。**插件调用不会自动重试。** |
| V7 | 断网时的表现 | ✅ 实测 | 主 AI 先重试 5 次，每次写 `llm/retry`、`llm/retry-started`、`assistant/attempt` 事件，约 9–16 秒后写 `turn/end { kind: 'error', error.code: 'TRANSPORT' }`，同时触发 `agent/error`。界面显示"已重试模型请求 (5/5)"。 |
| V8 | 额度不足、限流等错误码 | ✅ 实测 | 见第 3 节的错误码表。 |
| V9 | 内置工具名 | ✅ 实测 | `read`、`write`、`edit`、`bash`、`glob`、`grep`、`todo_write`、`ask_user_question`、`web_fetch`、`web_search`、`subagent`…… 路径参数是 `file_path`，命令参数是 `command`。`write` 的结果在 `meta` 里带 `{ operation: 'create', path: <绝对路径> }`。 |
| V10 | 轮次结束的种类 | ✅ 实测 + 源码 | 种类有 `completed`、`error{error}`、`aborted{reason}`、`max-tokens`、`blocked`、`interrupted`、`forked`。用户取消是 `aborted` 且 `reason.kind === 'user'`，可以和其他中止区分。 |
| V11 | SSE 推送 | ✅ 实测 | handler 拿到的是原生 Node `req`/`res`，可以分段 `res.write`，实测每 700 ms 一段按时到达。 |
| V12 | 数据目录 | ✅ 实测 | 插件进程里 `process.env.DSH_HOME` 有值；也可以引用 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath()`。宿主没有提供 home 服务。另有 `storageDomain` 可选。 |
| V13 | 安装方式 | ⚠️ 部分 | `dsh plugin --profile web add <路径或包名>` 可用，会自动登记到 profile 的 bundles 并热加载。DSH Desktop 用的也是 `web` profile。**桌面版「插件 → 添加插件」界面没有实测**，因为需要在你的日常应用里操作。 |

## 3. 模型错误码对照（V7、V8）

| 场景 | `failure.code` | 主 AI 是否自动重试 | 宿主界面文案 |
| --- | --- | --- | --- |
| 断网、连接被断开、流中途断 | `TRANSPORT` | 是，5 次 | DeepSeek Messages transport failed |
| 限流 429 | `RATE_LIMIT` | 是，5 次（约 16 秒） | Rate limit reached |
| 额度或余额不足 402 | `QUOTA`（账号登录方式下为 `ACCOUNT_QUOTA`） | 否 | 账户额度或余额不足，请充值或检查服务商的用量限制 |
| 密钥无效 401 | `AUTH` | 否 | （原文） |
| 403 | `FORBIDDEN` | 否 | — |
| 服务故障 5xx | `SERVER` | 是 | — |
| 上下文超长 | `CONTEXT_WINDOW_EXCEEDED` | 否 | — |
| 没有配置密钥 | `MISSING_CREDENTIAL` | 否 | no API key for provider route … |
| 回复被截断 | `finish.kind = 'max-tokens'`，轮次结束为 `max-tokens` | 否 | — |
| 长时间无输出 | `TIMEOUT` | 是 | 默认要 **300 秒**无数据才判定 |

## 4. 需要改设计的地方

1. **"长时间没动静"必须靠插件自己计时。** 宿主 300 秒无数据才报 `TIMEOUT`，对用户来说太晚。插件看到 `agent/status = running` 后，如果 180 秒没有新事件就提醒（C8）。
2. **"正在重试"可以实时提醒。** 第一个 `llm/retry` 事件就能显示"正在重试 (1/5)"，不用等 15 秒后的最终失败（A2）。
3. **命令失败要从文本识别。** `bash` 的非零退出不算错误（`isError: false`），失败体现在结果文本末尾的 `[exit code: N]`，以及 `job/settled.detail = "exit code: N"`。B 类检测器和"检查是否通过"都要按这个解析。
4. **插件的模型调用要自己重试，并显式设置 `maxTokens`。** 对 `RATE_LIMIT`、`TRANSPORT`、`SERVER` 最多重试 2 次；每类调用都设 `maxTokens`，否则默认 256000。
5. **插件接口不会被宿主自动保护。** 不带 cookie 的请求也能到达插件的 handler，必须在每个 handler 里调用 `connection.requestRejection(req)`。实测从页面发起的请求返回 `undefined`（放行），curl 无 cookie 返回 401，外部 Origin 返回 403。
6. **注册扩展点要用 `{ id, order }`，不能用 `key`。** 用 `key` 注册 `conversation.input.dock` 和 `assistant-actions` 时组件不会渲染。侧栏正文 `sidebar.right.pane.tab` 例外，它用 `key`，值为标签类型的 `id`。

## 5. 新增发现

- **没有官方的划词或右键扩展点。** F3 只能监听 DOM 选区。`[data-chat-flow]`、`[data-composer-card]` 这两个属性实测存在，但**没有文档，也没有稳定性承诺**；有文档的只有 `data-chat-anchor-key`。F3 需要做降级：检测不到对话区时，只在侧栏内提供划词。
- **客户端能直接拿到会话状态。** 扩展点 props 中的 `session` 带有 `running`、`lastAgentError`、`promptError`。A 类异常可以在客户端即时显示，不必等宿主端推送。
- **授权请求只能通过事件识别。** `agent/status` 只有 `idle` 和 `running` 两种状态，没有"等授权"。D1 改用 `approval/request` 监听（只观察，原样 `return next()`），以及会话中的 `approval/asked`、`approval/decided` 事件。标准模式下 `bash` 没有触发授权，这一项只做了源码核对。
- **插件宿主端代码修改后必须重启宿主才生效。** 修改 profile 或 patch 会热加载。开发时需要一个重启脚本，`spikes/m0/README.md` 里有。
- **桌面窗口加载的是宿主的本地 http 地址**（`desktopHarnessUrl`），和浏览器访问是同一个来源，所以插件页面可以直接 `fetch` 自己的接口。这一点是从源码确认的，没有在桌面窗口里实测。

## 6. 未覆盖

- 真实 DeepSeek 服务的错误文案：只用了假服务。错误码映射是从源码和假服务两方面确认的。
- 上下文压缩事件（`compaction/*`）的实际触发（C7）：只做了源码核对。
- 在你日常使用的 DSH Desktop 里，通过「添加插件」界面安装。
- 桌面窗口（Electron）里的扩展点渲染：验证都在浏览器里完成，两者加载的是同一套页面代码。
