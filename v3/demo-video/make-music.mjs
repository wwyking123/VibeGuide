#!/usr/bin/env node
// 合成一段原创的背景音乐（不依赖任何素材，没有版权问题）：柔和的铺底和弦 + 稀疏的电钢琴分解音 + 很轻的律动。
//   node make-music.mjs <秒数> <输出.wav>
// 想换成自己的音乐：不用这个脚本，直接把音频文件交给 make-video.sh（见里面的说明）。
import fs from 'node:fs';

const DUR = Number(process.argv[2] || 150);
const OUT = process.argv[3] || 'music.wav';
const SR = 44100, N = Math.ceil(DUR * SR);
const L = new Float32Array(N), R = new Float32Array(N);

const BPM = 84, BEAT = 60 / BPM, BAR = BEAT * 4;
const hz = m => 440 * Math.pow(2, (m - 69) / 12);
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// D 大调，每个和弦两小节：Dmaj9 → A/C# → Bm7 → Gmaj7（温和、向上的走向）
const CHORDS = [
  { bass: 38, pad: [57, 61, 64, 66], arp: [62, 66, 69, 73, 76, 78] },   // D
  { bass: 37, pad: [57, 61, 64, 68], arp: [61, 64, 69, 73, 76, 80] },   // A/C#
  { bass: 35, pad: [57, 59, 62, 66], arp: [62, 66, 69, 71, 74, 78] },   // Bm7
  { bass: 43, pad: [55, 59, 62, 66], arp: [62, 66, 67, 71, 74, 78] },   // Gmaj7
];
const chordAt = bar => CHORDS[Math.floor(bar / 2) % CHORDS.length];
const BARS = Math.ceil(DUR / BAR);
const INTRO = 2, OUTRO_T = DUR - 8;                 // 头两小节只有铺底；最后 8 秒收掉律动

function add(buf, i, v) { if (i >= 0 && i < N) buf[i] += v; }

// 铺底：每个和弦音用两路略微失谐的正弦 + 一点泛音，缓起缓落，左右各偏一点
for (let b = 0; b < BARS; b += 2) {
  const c = chordAt(b), t0 = b * BAR, len = BAR * 2 + 1.2;
  c.pad.forEach((m, k) => {
    const f = hz(m), pan = (k / (c.pad.length - 1)) * .6 + .2, det = 1 + (k % 2 ? .0022 : -.0018);
    const i0 = Math.floor(t0 * SR), n = Math.floor(len * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 1.4) * Math.min(1, (len - t) / 1.6);
      const s = (Math.sin(2 * Math.PI * f * t) + .5 * Math.sin(2 * Math.PI * f * det * t + 1) + .16 * Math.sin(2 * Math.PI * f * 2 * t) + .05 * Math.sin(2 * Math.PI * f * 3 * t)) * env * .052;
      add(L, i0 + i, s * (1 - pan)); add(R, i0 + i, s * pan);
    }
  });
  // 低音：根音的正弦，轻轻托住
  const fb = hz(c.bass), i0 = Math.floor(t0 * SR), n = Math.floor((BAR * 2) * SR);
  if (b >= INTRO) for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / .08) * Math.min(1, (BAR * 2 - t) / .5);
    const s = (Math.sin(2 * Math.PI * fb * t) + .5 * Math.sin(2 * Math.PI * fb * 2 * t)) * env * .05;
    add(L, i0 + i, s); add(R, i0 + i, s);
  }
}

// 电钢琴：正弦 + 少量泛音，指数衰减。每小节一个稀疏的八分音符型
function pluck(t0, m, vel, pan) {
  const f = hz(m), i0 = Math.floor(t0 * SR), n = Math.floor(2.6 * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, t / .006) * Math.exp(-t * 2.3);
    const s = (Math.sin(2 * Math.PI * f * t + 1.6 * Math.exp(-t * 7) * Math.sin(2 * Math.PI * f * 2 * t)) + .22 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-t * 4)) * env * vel * .17;
    add(L, i0 + i, s * (1 - pan)); add(R, i0 + i, s * pan);
  }
}
const PATTERNS = [[0, 1.5, 2, 3.5], [0, 1, 2.5, 3], [0.5, 1.5, 2.5, 3.5], [0, 1.5, 3, 3.5]];
for (let b = INTRO; b < BARS; b++) {
  const t0 = b * BAR; if (t0 > OUTRO_T + 2) break;
  const c = chordAt(b), pat = PATTERNS[b % PATTERNS.length];
  pat.forEach((beat, k) => {
    const idx = [0, 2, 1, 3, 2, 4][(b * 3 + k * 2) % 6] + ((b % 4 === 3 && k === 3) ? 1 : 0);
    const m = c.arp[Math.min(idx, c.arp.length - 1)];
    pluck(t0 + beat * BEAT + (rnd() - .5) * .012, m, .7 + rnd() * .3 - (k % 2 ? .12 : 0), .32 + rnd() * .36);
  });
}

// 很轻的律动：第 1、3 拍一个柔和的低频"咚"，反拍一点点沙沙声（进得晚、出得早）
for (let b = INTRO + 2; b < BARS; b++) {
  for (let q = 0; q < 4; q++) {
    const t0 = b * BAR + q * BEAT; if (t0 > OUTRO_T) break;
    if (q % 2 === 0) {
      const i0 = Math.floor(t0 * SR), n = Math.floor(.32 * SR); let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR, f = 46 + 60 * Math.exp(-t * 34); ph += 2 * Math.PI * f / SR;
        const s = Math.sin(ph) * Math.exp(-t * 13) * .075;
        add(L, i0 + i, s); add(R, i0 + i, s);
      }
    }
    const i1 = Math.floor((t0 + BEAT / 2) * SR), n1 = Math.floor(.07 * SR); let lp = 0, prev = 0;
    for (let i = 0; i < n1; i++) {
      const w = rnd() * 2 - 1; lp = lp * .55 + w * .45; const hp = w - lp;      // 只留高频
      const s = (hp - prev * .2) * Math.exp(-(i / SR) * 60) * .022; prev = hp;
      add(L, i1 + i, s * .8); add(R, i1 + i, s * 1.1);
    }
  }
}

// 空间感：左右交替的回声 + 一点点混响（几路短延时）
function echo(src, dst, delaySec, gain) { const d = Math.floor(delaySec * SR); for (let i = d; i < N; i++) dst[i] += src[i - d] * gain; }
const dryL = Float32Array.from(L), dryR = Float32Array.from(R);
echo(dryL, R, BEAT * .75, .2); echo(dryR, L, BEAT * 1.5, .13);
for (const [d, g] of [[.031, .1], [.047, .085], [.071, .07], [.113, .055]]) { echo(dryL, R, d, g); echo(dryR, L, d * 1.07, g); }

// 收尾：淡入淡出 + 归一化（留 3dB 余量）
let peak = 0, sum = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR, fade = Math.min(1, t / 2) * Math.min(1, (DUR - t) / 4.5);
  L[i] *= fade; R[i] *= fade;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const g = .5 / peak;
const pcm = Buffer.alloc(44 + N * 4);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + N * 4, 4); pcm.write('WAVEfmt ', 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(2, 22);
pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 4, 28); pcm.writeUInt16LE(4, 32); pcm.writeUInt16LE(16, 34); pcm.write('data', 36); pcm.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const l = Math.max(-1, Math.min(1, L[i] * g)), r = Math.max(-1, Math.min(1, R[i] * g));
  sum += l * l + r * r;
  pcm.writeInt16LE(Math.round(l * 32767), 44 + i * 4); pcm.writeInt16LE(Math.round(r * 32767), 46 + i * 4);
}
fs.writeFileSync(OUT, pcm);
console.log(`音乐：${DUR.toFixed(1)} 秒，${BPM} BPM，峰值 ${(20 * Math.log10(.5)).toFixed(1)} dBFS，平均响度约 ${(10 * Math.log10(sum / (2 * N))).toFixed(1)} dBFS → ${OUT}`);
