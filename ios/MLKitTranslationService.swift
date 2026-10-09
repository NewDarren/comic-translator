import Foundation
import UIKit
import MLKitCommon
import MLKitTextRecognition
import MLKitTextRecognitionCommon
import MLKitTranslate
import MLKitVision

private struct OCRBlock {
    let text: String
    let frame: CGRect
    let lineCount: Int
}

/// An intentionally cautious on-device alternative to the image-model service.
/// OCR rectangles are not speech-bubble rectangles: only lettering on a verified
/// near-white, flat background is eligible for an overlay. Everything else stays
/// visible in the original comic.
@MainActor
enum MLKitTranslationService {
    private static let recognizer = TextRecognizer.textRecognizer(options: TextRecognizerOptions())
    private static let translator = Translator.translator(
        options: TranslatorOptions(sourceLanguage: .english, targetLanguage: .chinese)
    )

    /// `comicRects` are the currently visible comic-image bounds in `image.size`
    /// coordinates, as opposed to the OCR result's pixel coordinates. An empty ROI
    /// means that no text can be translated safely; page UI is excluded from overlays.
    static func translate(image: UIImage, comicRects: [CGRect]) async throws -> TranslationResult {
        guard !comicRects.isEmpty else { return TranslationResult(regions: []) }
        guard image.imageOrientation == .up, let cgImage = image.cgImage,
              cgImage.width > 0, cgImage.height > 0,
              cgImage.width <= 12_000, cgImage.height <= 12_000,
              cgImage.width * cgImage.height <= 12_000_000,
              image.size.width > 0, image.size.height > 0 else {
            throw ReaderError.message("无法识别此屏截图，请刷新网页后重试。")
        }
        try Task.checkCancellation()

        // Giving ML Kit a scale-1 UIImage makes its frame coordinates pixel-based.
        // The DOM image bounds arrive in UIImage points, which can differ on Retina.
        let pixelImage = UIImage(cgImage: cgImage, scale: 1, orientation: .up)
        let scaleX = CGFloat(cgImage.width) / image.size.width
        let scaleY = CGFloat(cgImage.height) / image.size.height
        let imageBounds = CGRect(x: 0, y: 0, width: CGFloat(cgImage.width), height: CGFloat(cgImage.height))
        let rois = comicRects.compactMap { rect -> CGRect? in
            guard rect.isFinite, rect.width > 0, rect.height > 0 else { return nil }
            let pixels = CGRect(x: rect.minX * scaleX, y: rect.minY * scaleY,
                                width: rect.width * scaleX, height: rect.height * scaleY)
            return imageBounds.intersection(pixels).isNull ? nil : imageBounds.intersection(pixels)
        }
        guard !rois.isEmpty else { return TranslationResult(regions: []) }

        let visionImage = VisionImage(image: pixelImage)
        visionImage.orientation = .up
        let allBlocks: [OCRBlock]
        do {
            allBlocks = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<[OCRBlock], Error>) in
                recognizer.process(visionImage) { recognized, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let recognized {
                        continuation.resume(returning: recognized.blocks.map {
                            OCRBlock(text: $0.text, frame: $0.frame, lineCount: $0.lines.count)
                        })
                    } else {
                        continuation.resume(throwing: ReaderError.message("图片识字没有返回结果。"))
                    }
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ReaderError.message("设备端图片识字失败，请刷新漫画画面后手动重试。")
        }
        try Task.checkCancellation()
        guard let bitmap = FlatImage(cgImage: cgImage) else {
            throw ReaderError.message("无法检查漫画背景，未覆盖原图。")
        }
        var candidates = [(original: String, erase: CGRect, color: String)]()
        for index in allBlocks.indices.prefix(100) {
            try Task.checkCancellation()
            let block = allBlocks[index]
            let original = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let frame = block.frame.standardized
            guard block.lineCount > 0, block.lineCount <= 8,
                  original.count >= 3, original.count <= 500,
                  frame.isFinite, frame.width >= 24, frame.height >= 10,
                  frame.height <= CGFloat(cgImage.height) * 0.20,
                  englishEnough(original) else { continue }
            let padding = max(3, min(7, frame.height * 0.12))
            let erase = frame.insetBy(dx: -padding, dy: -padding)
            let safety = erase.insetBy(dx: -padding, dy: -padding)
            guard rois.contains(where: { $0.insetBy(dx: 1, dy: 1).contains(safety) }),
                  !allBlocks.indices.contains(where: { otherIndex in
                      otherIndex != index && allBlocks[otherIndex].frame.intersects(erase)
                  }),
                  let color = bitmap.flatLightBackground(erase: erase, safety: safety) else { continue }
            candidates.append((original, erase, color))
            if candidates.count >= 30 { break }
        }
        guard !candidates.isEmpty else { return TranslationResult(regions: []) }

        // Models download once per device. Disallow cellular data by default; a
        // downloaded model can then translate without a paid translation API.
        let conditions = ModelDownloadConditions(
            allowsCellularAccess: false, allowsBackgroundDownloading: false
        )
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                translator.downloadModelIfNeeded(with: conditions) { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: ()) }
                }
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ReaderError.message("设备端翻译模型下载失败。请连接 Wi-Fi 后在设置里手动重试。")
        }
        try Task.checkCancellation()

        var regions = [TranslationRegion]()
        for item in candidates {
            try Task.checkCancellation()
            let raw: String
            do {
                raw = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
                    translator.translate(item.original) { text, error in
                        if let error { continuation.resume(throwing: error) }
                        else if let text { continuation.resume(returning: text) }
                        else { continuation.resume(throwing: ReaderError.message("设备端翻译没有返回文字。")) }
                    }
                }
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                throw ReaderError.message("设备端翻译失败，请在设置里手动重试。")
            }
            let translated = simplified(raw).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !translated.isEmpty, translated != item.original,
                  translated.count <= 1000,
                  let rect = normalized(item.erase, width: CGFloat(cgImage.width), height: CGFloat(cgImage.height))
            else { continue }
            let region = TranslationRegion(original: item.original, translation: translated,
                                           erase: rect, box: rect,
                                           background: item.color, foreground: "#111111")
            if region.isValid { regions.append(region) }
        }
        return TranslationResult(regions: regions)
    }

    private static func englishEnough(_ text: String) -> Bool {
        let letters = text.unicodeScalars.filter { CharacterSet.letters.contains($0) }
        let latin = letters.filter { (65...90).contains(Int($0.value)) || (97...122).contains(Int($0.value)) }
        return latin.count >= 3 && latin.count * 4 >= letters.count * 3
    }

    private static func simplified(_ text: String) -> String {
        // ML Kit exposes one Chinese target (`zh`), without a variant selector.
        // ICU's orthographic transform converts traditional glyphs when present;
        // it cannot fix a wrong translation or guarantee regional wording.
        let output = NSMutableString(string: text)
        let changed = output.applyTransform(StringTransform("Traditional-Simplified"), reverse: false,
                                            range: NSRange(location: 0, length: output.length),
                                            updatedRange: nil)
        return changed ? output as String : text
    }

    private static func normalized(_ rect: CGRect, width: CGFloat, height: CGFloat) -> TranslationRect? {
        let result = TranslationRect(x: Double(rect.minX / width * 1000),
                                     y: Double(rect.minY / height * 1000),
                                     w: Double(rect.width / width * 1000),
                                     h: Double(rect.height / height * 1000))
        return result.isValid ? result : nil
    }
}

private extension CGRect {
    var isFinite: Bool {
        [minX, minY, width, height].allSatisfy { $0.isFinite }
    }
}

/// Canonical RGBA pixels used solely to decide whether replacing lettering is
/// safe. The source CGImage is never changed or written back to the page.
private struct FlatImage {
    private let width: Int
    private let height: Int
    private let pixels: [UInt8]

    init?(cgImage: CGImage) {
        let width = cgImage.width
        let height = cgImage.height
        let stride = width * 4
        var pixels = [UInt8](repeating: 255, count: stride * height)
        let rendered = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height,
                                          bitsPerComponent: 8, bytesPerRow: stride,
                                          space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue |
                                              CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.setFillColor(UIColor.white.cgColor)
            context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
            // Match top-left UIKit/ML Kit coordinates when accessing bitmap rows.
            context.translateBy(x: 0, y: CGFloat(height))
            context.scaleBy(x: 1, y: -1)
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
            return true
        }
        guard rendered else { return nil }
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    func flatLightBackground(erase: CGRect, safety: CGRect) -> String? {
        let e = erase.integral
        let s = safety.integral
        guard s.minX >= 0, s.minY >= 0, s.maxX <= CGFloat(width), s.maxY <= CGFloat(height) else { return nil }
        var border = [(Int, Int, Int)]()
        let step = max(1, Int(min(e.width, e.height) / 35))
        for y in stride(from: Int(s.minY), to: Int(s.maxY), by: step) {
            for x in stride(from: Int(s.minX), to: Int(s.maxX), by: step) {
                if !e.contains(CGPoint(x: CGFloat(x), y: CGFloat(y))) { border.append(rgb(x, y)) }
            }
        }
        guard border.count >= 12 else { return nil }
        let red = border.map { $0.0 }.reduce(0, +) / border.count
        let green = border.map { $0.1 }.reduce(0, +) / border.count
        let blue = border.map { $0.2 }.reduce(0, +) / border.count
        guard min(red, green, blue) >= 228,
              border.allSatisfy({ abs($0.0 - red) <= 14 && abs($0.1 - green) <= 14 && abs($0.2 - blue) <= 14 })
        else { return nil }

        var dark = 0
        var inspected = 0
        for y in stride(from: Int(e.minY), to: Int(e.maxY), by: 2) {
            for x in stride(from: Int(e.minX), to: Int(e.maxX), by: 2) {
                let (r, g, b) = rgb(x, y)
                let nearBackground = abs(r - red) <= 28 && abs(g - green) <= 28 && abs(b - blue) <= 28
                let grayInk = max(r, g, b) <= 225 && max(r, g, b) - min(r, g, b) <= 18
                guard nearBackground || grayInk else { return nil }
                if max(r, g, b) <= 170 { dark += 1 }
                inspected += 1
            }
        }
        guard inspected >= 30, dark >= max(2, inspected / 100), dark <= inspected * 45 / 100 else { return nil }
        return String(format: "#%02X%02X%02X", red, green, blue)
    }

    private func rgb(_ x: Int, _ y: Int) -> (Int, Int, Int) {
        let index = (y * width + x) * 4
        return (Int(pixels[index]), Int(pixels[index + 1]), Int(pixels[index + 2]))
    }
}
