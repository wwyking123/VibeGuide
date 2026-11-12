// 把逐帧 PNG 合成为 H.264 MP4（用 macOS 自带的 AVFoundation，不需要 ffmpeg）。
//   swiftc -O encode.swift -o encode && ./encode <帧目录> <输出.mp4> [fps=30] [码率=6000000]
import AVFoundation
import CoreGraphics
import Foundation
import ImageIO

let args = CommandLine.arguments
guard args.count >= 3 else { print("用法: encode <帧目录> <输出.mp4> [fps] [码率]"); exit(1) }
let dir = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let fps = args.count > 3 ? Int32(args[3])! : 30
let bitrate = args.count > 4 ? Int(args[4])! : 6_000_000

let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix("f_") && $0.hasSuffix(".png") }.sorted()
guard !files.isEmpty else { print("帧目录里没有 f_*.png"); exit(1) }
func load(_ name: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(dir.appendingPathComponent(name) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fatalError("读不了帧 \(name)") }
    return img
}
let first = load(files[0])
let w = first.width, h = first.height

try? FileManager.default.removeItem(at: outURL)
let writer = try AVAssetWriter(outputURL: outURL, fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: w, AVVideoHeightKey: h,
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ],
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: Int(fps) * 2,
        AVVideoExpectedSourceFrameRateKey: Int(fps),
    ],
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
])
writer.add(input)
guard writer.startWriting() else { print("无法开始写入: \(String(describing: writer.error))"); exit(1) }
writer.startSession(atSourceTime: .zero)

let space = CGColorSpace(name: CGColorSpace.sRGB)!
for (i, name) in files.enumerated() {
    autoreleasepool {
        let img = load(name)
        while !input.isReadyForMoreMediaData { usleep(2000) }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
        let buf = pb!
        CVPixelBufferLockBaseAddress(buf, [])
        let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: w, height: h, bitsPerComponent: 8,
                            bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: space,
                            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        CVPixelBufferUnlockBaseAddress(buf, [])
        if !adaptor.append(buf, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps)) {
            fatalError("写入第 \(i) 帧失败: \(String(describing: writer.error))")
        }
    }
    if (i + 1) % 600 == 0 { print("已编码 \(i + 1)/\(files.count) 帧") }
}
input.markAsFinished()
let sem = DispatchSemaphore(value: 0)
writer.finishWriting { sem.signal() }
sem.wait()
if writer.status == .completed {
    let size = (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
    print(String(format: "完成：%d 帧，%d×%d，%.1f 秒，%.1f MB → %@", files.count, w, h, Double(files.count) / Double(fps), Double(size) / 1_048_576, outURL.path))
} else {
    print("编码失败: \(String(describing: writer.error))"); exit(1)
}
