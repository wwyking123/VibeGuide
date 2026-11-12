#!/bin/sh
# 一键重新生成宣传示意片：逐帧渲染 → 合成 MP4 → 配背景音乐（约 10 分钟）。
#   sh make-video.sh                 用 make-music.mjs 合成的原创背景音乐
#   sh make-video.sh 我的音乐.mp3     换成你自己的音乐（mp3 / wav / m4a 都行；比视频长会自动截到视频长度）
# 改文案或节奏：编辑 scenario.js。只想预览不导出：用浏览器打开 index.html，会实时播放（无声）。
set -e
MUSIC="$1"
[ -n "$MUSIC" ] && MUSIC="$(cd "$(dirname "$MUSIC")" && pwd)/$(basename "$MUSIC")"
cd "$(dirname "$0")"
mkdir -p out
[ -x out/encode ] || swiftc -O encode.swift -o out/encode
[ -x out/mux ] || swiftc -O mux.swift -o out/mux

node render.mjs --out out/frames
out/encode out/frames "out/VibeGuide-宣传示意片-无音乐.mp4" 30 6000000
FRAMES=$(ls out/frames | grep -c '^f_')
rm -rf out/frames

if [ -z "$MUSIC" ]; then
  node make-music.mjs "$(echo "$FRAMES / 30" | bc -l)" out/music.wav
  MUSIC=out/music.wav
fi
afconvert -f m4af -d aac -b 160000 "$MUSIC" out/music.m4a
out/mux "out/VibeGuide-宣传示意片-无音乐.mp4" out/music.m4a "out/VibeGuide-宣传示意片.mp4"
