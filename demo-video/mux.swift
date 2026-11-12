// 把一条音轨合进视频（画面原样拷贝，不重新压缩）。音轨比视频长会被截到视频长度。
//   swiftc -O mux.swift -o mux && ./mux <视频.mp4> <音频.m4a> <输出.mp4>
import AVFoundation
import Foundation

let a = CommandLine.arguments
guard a.count >= 4 else { print("用法: mux <视频.mp4> <音频.m4a> <输出.mp4>"); exit(1) }
let video = AVURLAsset(url: URL(fileURLWithPath: a[1])), audio = AVURLAsset(url: URL(fileURLWithPath: a[2]))
let outURL = URL(fileURLWithPath: a[3])
guard let vt = video.tracks(withMediaType: .video).first else { print("视频里没有画面轨"); exit(1) }
guard let at = audio.tracks(withMediaType: .audio).first else { print("音频文件里没有音轨"); exit(1) }

let comp = AVMutableComposition()
let dur = video.duration
let cv = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
try cv.insertTimeRange(CMTimeRange(start: .zero, duration: dur), of: vt, at: .zero)
let ca = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
try ca.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(dur, audio.duration)), of: at, at: .zero)

try? FileManager.default.removeItem(at: outURL)
guard let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough) else { print("无法创建导出任务"); exit(1) }
ex.outputURL = outURL; ex.outputFileType = .mp4; ex.shouldOptimizeForNetworkUse = true
let sem = DispatchSemaphore(value: 0)
ex.exportAsynchronously { sem.signal() }
sem.wait()
if ex.status == .completed {
    let size = (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
    print(String(format: "已配乐：%.1f 秒，%.1f MB → %@", CMTimeGetSeconds(dur), Double(size) / 1_048_576, outURL.path))
} else { print("合成失败: \(String(describing: ex.error))"); exit(1) }
