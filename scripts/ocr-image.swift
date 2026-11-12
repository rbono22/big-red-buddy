import Foundation
import Vision
import ImageIO

// Local-only OCR. The caller supplies a private temporary path, enforces a timeout,
// and captures stdout; no image, recognized text, or telemetry is sent over a network.
do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "OCR", code: 1) }
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
          width.intValue > 0, height.intValue > 0,
          width.intValue <= 12000, height.intValue <= 12000,
          width.intValue * height.intValue <= 24000000 else { throw NSError(domain: "OCR", code: 2) }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 3000]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw NSError(domain: "OCR", code: 3) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    request.usesCPUOnly = true
    request.minimumTextHeight = 0.003
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let observations = (request.results ?? []).sorted {
        let delta = $0.boundingBox.midY - $1.boundingBox.midY
        return abs(delta) > 0.006 ? delta > 0 : $0.boundingBox.minX < $1.boundingBox.minX
    }
    let lines: [[String: Any]] = observations.prefix(3000).compactMap { observation in
        guard let value = observation.topCandidates(1).first else { return nil }
        return ["text": String(value.string.prefix(2000)), "confidence": value.confidence]
    }
    let result: [String: Any] = ["lines": lines, "width": width.intValue, "height": height.intValue]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    // Avoid paths, document text, and provider diagnostics in error output.
    FileHandle.standardError.write(Data("Local image OCR could not complete.\n".utf8))
    exit(1)
}
