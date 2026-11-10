#!/bin/sh
# VibeGuide 一键安装 / 更新：macOS + DeepSeek Harness 桌面版。
# 不需要 Node 或 git：下载预先构建好的包，用 Harness 自带的运行环境执行安装器。
# VIBEGUIDE_PACKAGE（包地址）、VIBEGUIDE_APP、VIBEGUIDE_HOME 只供测试覆盖。
set -eu

REPO="wwyking123/VibeGuide"
APP="${VIBEGUIDE_APP:-/Applications/DeepSeek Harness.app}"
DSH="${VIBEGUIDE_HOME:-$HOME/.dsh}"
BIN="$APP/Contents/MacOS/DeepSeek Harness"

fail() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "目前只支持 Mac。"
[ -x "$BIN" ] || fail "没有找到 DeepSeek Harness 桌面版（应该在“应用程序”里）。请先安装它，再运行这条命令。"
[ -f "$DSH/profiles/desktop/package.json" ] || fail "请先打开一次 DeepSeek Harness，再运行这条命令。"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "正在下载 VibeGuide…"
downloaded=""
for url in ${VIBEGUIDE_PACKAGE:-} \
  "https://raw.githubusercontent.com/$REPO/release/vibeguide.tgz" \
  "https://cdn.jsdelivr.net/gh/$REPO@release/vibeguide.tgz" \
  "https://fastly.jsdelivr.net/gh/$REPO@release/vibeguide.tgz"; do
  rm -rf "$TMP/vibeguide"
  if curl -fsSL --connect-timeout 8 --max-time 120 "$url" -o "$TMP/vibeguide.tgz" 2>/dev/null \
    && tar -xzf "$TMP/vibeguide.tgz" -C "$TMP" 2>/dev/null \
    && [ -f "$TMP/vibeguide/scripts/install-desktop.mjs" ]; then
    downloaded=1
    break
  fi
done
[ -n "$downloaded" ] || fail "下载失败。请检查网络后再试一次。"

echo "正在安装…"
if ! ELECTRON_RUN_AS_NODE=1 "$BIN" --expose-internals "$TMP/vibeguide/scripts/install-desktop.mjs" \
  --app "$APP" --home "$DSH" --upgrade > "$TMP/install.log" 2>&1; then
  reason=$(sed -n 's/^[A-Za-z]*Error[^:]*: //p' "$TMP/install.log" | head -1)
  fail "安装没有完成，你的 Harness 设置没有被改动。${reason:+原因：$reason}"
fi

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/vibeguide/package.json" | head -1)
cat <<EOF

✓ VibeGuide $version 安装好了。

接下来：
  1. 完全退出 DeepSeek Harness（Cmd+Q），再重新打开
  2. 新建会话，在输入框上方的模式菜单选 VibeGuide
  3. 从右侧打开 VibeGuide 侧栏

以后更新，再运行一次同一条命令就行。
EOF
