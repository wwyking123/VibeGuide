# M0 验证代码

这里是 M0 技术验证用的一次性代码，不是产品代码。结论见 [docs/M0_REPORT.md](../../docs/M0_REPORT.md)。

- `probe/`：探测插件，只读取和记录，从不发送消息、不修改会话。
  - 宿主端提供 `/plugins/vg-probe/{log,services,admission,session,turn,llm,sse}` 这几个接口。
  - 客户端把记录写到页面上的 `window.__vgProbe`。
- `fake-llm.mjs`：假的 DeepSeek 接口（Anthropic Messages 风格，`/v1/messages`），可以按脚本返回正常回复、工具调用或各种错误。

## 复现

**1. 启动假模型服务。**

```bash
node fake-llm.mjs 18080
```

**2. 用临时数据目录启动隔离宿主。**

把 `$TMP_HOME` 换成一个空目录。不要用日常的 `~/Library/Application Support/dsh-desktop/harness`。

```bash
R="/Applications/DSH Desktop.app/Contents/Resources"; ELECTRON_RUN_AS_NODE=1 DSH_HOME="$TMP_HOME" DEEPSEEK_BASE_URL=http://127.0.0.1:18080 DEEPSEEK_API_KEY=sk-fake "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" --expose-internals "$R/harness-node-entry.mjs" "$R/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js" web --patch "$R/dsh-desktop.patch.yml" --no-open --host 127.0.0.1 --port 17690
```

**3. 安装探测插件。**

安装后宿主会热加载插件。注意：之后改了 `probe/lib/index.js`，要重启宿主才会生效。

```bash
R="/Applications/DSH Desktop.app/Contents/Resources"; ELECTRON_RUN_AS_NODE=1 DSH_HOME="$TMP_HOME" DSH_DESKTOP_PNPM_ENTRY="$R/app.asar/node_modules/pnpm/bin/pnpm.cjs" "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop" --expose-internals "$R/harness-node-entry.mjs" "$R/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js" plugin --profile web add link:"$PWD/probe"
```

**4. 打开页面。** 在浏览器里打开宿主日志中打印的 `http://127.0.0.1:17690/?token=…`。

**5. 给假模型排脚本。** 例如连续返回 6 次限流：

```bash
curl -s -X POST http://127.0.0.1:18080/__script -d '[{"status":429},{"status":429},{"status":429},{"status":429},{"status":429},{"status":429}]'
```

## 注意

- 隔离宿主的默认工作区是 `~/Documents/deepseek-harness/default-workspace`。主 AI 调用写文件工具时，文件会写在这里，测试结束后记得清理。
