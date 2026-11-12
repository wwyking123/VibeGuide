#!/bin/sh
# Install this local, prebuilt package. Does not download a remote release.
set -eu
VIBEGUIDE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP="${VIBEGUIDE_APP:-/Applications/DeepSeek Harness.app}"
if [ -z "${VIBEGUIDE_APP:-}" ] && [ ! -d "$APP" ]; then APP='/Applications/DSH Desktop.app'; fi
BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
if [ ! -x "$BIN" ]; then BIN="$APP/Contents/MacOS/DeepSeek Harness"; fi
fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
[ "$(uname)" = Darwin ] || fail '目前只支持 Mac。'
[ -x "$BIN" ] || fail '没有找到 DeepSeek Harness 桌面版或 DSH Desktop。'
DSH="${VIBEGUIDE_HOME:-$HOME/Library/Application Support/dsh-desktop/harness}"
if [ -z "${VIBEGUIDE_HOME:-}" ] && [ ! -d "$DSH/profiles" ]; then DSH="$HOME/.dsh"; fi
if [ ! -f "$DSH/profiles/desktop/package.json" ] && [ ! -f "$DSH/profiles/web/package.json" ]; then fail '请先打开一次 DeepSeek Harness 或 DSH Desktop。'; fi
[ -f "$VIBEGUIDE_ROOT/dist/guide/plugin.js" ] || fail '这个源码目录尚未构建，请先运行 npm ci 和 npm run build。'
ELECTRON_RUN_AS_NODE=1 "$BIN" --expose-internals "$VIBEGUIDE_ROOT/scripts/install-desktop.mjs" --app "$APP" --home "$DSH" --upgrade
printf '\n安装完成。请在空闲时完全退出并重新打开 DSH，选择 VibeGuide 模式和右侧 VibeGuide 侧栏。\n'
