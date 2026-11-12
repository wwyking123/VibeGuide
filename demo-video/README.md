# VibeGuide 演示视频

约两分半的功能示意片，按 0.2 版现有的功能编排：先问清楚 → 做到哪了 → 说人话（和标准模式的回答对比）→ 一张图看懂 → 看不懂就问。

这是用网页画出来的动画，不是录屏。右侧 VibeGuide 侧栏用的是插件的真实样式（`sidebar.css` 由 `sync-sidebar.mjs` 从 `src/client` 里取出），对话内容是演示编排。

## 生成

需要 macOS、Node 和 Chrome。

```bash
sh make-video.sh
```

约十分钟，成片在 `out/VibeGuide-演示视频.mp4`（`out/` 不进 git）。换背景音乐：`sh make-video.sh 我的音乐.mp3`。

## 修改

| 想改什么 | 改哪里 |
| --- | --- |
| 文案、字幕、节奏、演示的例子 | `scenario.js` |
| 宿主窗口、字幕条、章节卡的样子 | `styles.css` |
| 侧栏的样子 | 改 `src/client` 里的真实样式，再运行 `node sync-sidebar.mjs` |

改完先看效果，不必每次都导出：

- 浏览器打开 `index.html`，会实时播放（无声）。
- `node render.mjs --shots --out out/shots` 只导出脚本里用 `shot()` 标记的关键画面。

## 来源

动画引擎（`engine.js`）、逐帧导出（`render.mjs`）、合成与配乐（`encode.swift`、`mux.swift`、`make-music.mjs`）和宿主窗口的画法，来自 `xin` 分支 `v3/demo-video` 的示意片。
