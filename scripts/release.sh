#!/bin/sh
# Packs the built plugin and commits it, with install.sh and install.ps1, to the local `release` branch.
# Both installers download vibeguide.tgz from that branch. Pushing is a separate, deliberate step.
set -eu
cd "$(dirname "$0")/.."

[ -z "$(git status --porcelain)" ] || { echo "有未提交的改动，先提交再发布。" >&2; exit 1; }
npm test
version=$(node -p "require('./package.json').version")
source=$(git rev-parse --short HEAD)

work=$(mktemp -d)
trap 'git worktree remove --force "$work/branch" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir -p "$work/vibeguide/scripts"
cp -R dist prompts package.json "$work/vibeguide/"
cp scripts/install-desktop.mjs scripts/desktop.mjs scripts/selftest.mjs "$work/vibeguide/scripts/"
COPYFILE_DISABLE=1 tar -czf "$work/vibeguide.tgz" -C "$work" vibeguide

if git show-ref --quiet refs/heads/release; then git worktree add --quiet "$work/branch" release
elif git show-ref --quiet refs/remotes/origin/release; then git worktree add --quiet -b release "$work/branch" origin/release
else git worktree add --quiet --orphan -b release "$work/branch"
fi
cp install.sh install.ps1 "$work/vibeguide.tgz" "$work/branch/"
printf '%s\n' "$version" > "$work/branch/VERSION"
git -C "$work/branch" add -A
if git -C "$work/branch" diff --cached --quiet; then echo "release 分支已经是 $version（$source），没有变化。"
else git -C "$work/branch" commit --quiet -m "release: $version ($source)"; echo "已提交到本地 release 分支：$version（$source）"
fi
echo "发布：git push origin release"
