import Foundation
import Capacitor
import UIKit
import Photos
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

enum PhotoExport {
    static func cleanupAfterRestart() {
        // Only this app's interrupted export copies, never retained originals.
        let directory = FileManager.default.temporaryDirectory
        for file in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            where file.lastPathComponent.hasPrefix("liuying-photos-") && file.pathExtension == "png" {
            try? FileManager.default.removeItem(at: file)
        }
    }
    // Photos doesn't reliably import WebP. Export a lossless PNG copy of a
    // still image, retaining the downloaded original in the app unchanged.
    static func prepare(_ file: URL, mime: String) throws -> (url: URL, temporary: Bool) {
        if ["video/mp4", "video/quicktime", "image/jpeg", "image/png", "image/gif"].contains(mime) {
            return (file, false)
        }
        guard mime == "image/webp",
              let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              CGImageSourceGetType(source) as String? == UTType.webP.identifier,
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0,
              width.doubleValue * height.doubleValue <= 48_000_000,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw MediaFailure("unsupported_export", "此图片格式、动画或分辨率暂不支持写入相册，请用分享按钮导出原文件。")
        }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("liuying-photos-\(UUID().uuidString).png")
        guard let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw MediaFailure("photos_failed", "无法准备相册副本。")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: output)
            throw MediaFailure("photos_failed", "无法准备相册副本。")
        }
        return (output, true)
    }
}

@objc(LocalMediaPlugin)
public class LocalMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalMediaPlugin"
    public let jsName = "LocalMedia"
    public let pluginMethods: [CAPPluginMethod] = ["settings", "configure", "request", "probe", "prepare",
        "promote", "list", "remove", "cancel", "share", "photos"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private var store: MediaStore?
    private var policy = [String: [String]]()
    private let defaults = UserDefaults.standard
    private let state = NSLock()
    private let slots = DispatchSemaphore(value: 3)
    private var operations = [String: MediaOperation]()
    private var downloadActive = false
    private var requests = [Date]()
    private var backgroundObserver: NSObjectProtocol?
    public override func load() {
        do {
            guard let url = Bundle.main.url(forResource: "policy", withExtension: "json") else { return }
            policy = try JSONDecoder().decode([String: [String]].self, from: Data(contentsOf: url))
            store = try MediaStore()
            PhotoExport.cleanupAfterRestart()
            backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                object: nil, queue: nil) { [weak self] _ in self?.cancelAll() }
        } catch { store = nil }
    }
    deinit {
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        cancelAll()
    }
    private func cancelAll() {
        state.lock(); let active = Array(operations.values); state.unlock()
        for op in active { op.cancel() }
    }
    private func work(_ call: CAPPluginCall, _ body: @escaping () throws -> [String: Any]) {
        guard store != nil else { call.reject("本机存储初始化失败。", "storage_error"); return }
        guard slots.wait(timeout: .now()) == .success else { call.reject("请等待当前操作完成。", "busy"); return }
        DispatchQueue.global(qos: .userInitiated).async {
            defer { self.slots.signal() }
            do { call.resolve(try body()) }
            catch let error as MediaFailure { call.reject(error.message, error.code) }
            catch { call.reject("操作失败，请检查网络、存储空间或重新解析。", "operation_failed") }
        }
    }
    private func throttle() throws {
        state.lock(); defer { state.unlock() }
        requests.removeAll { $0 < Date().addingTimeInterval(-60) }
        guard requests.count < 100 else { throw MediaFailure("rate_limit", "操作过于频繁，请稍后重试。") }
        requests.append(Date())
    }
    private func op(_ token: String, seconds: TimeInterval) -> MediaOperation {
        let operation = MediaOperation(seconds: seconds)
        state.lock(); operations[token] = operation; state.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { [weak operation] in operation?.cancel() }
        return operation
    }
    private func finish(_ token: String) {
        state.lock(); let operation = operations.removeValue(forKey: token); state.unlock()
        operation?.cancel()
    }
    private func allowed(_ scope: String) -> Set<String> {
        Set((policy[scope] ?? []) + (scope == "media" ? defaults.stringArray(forKey: "directHosts") ?? [] : []))
    }
    private var maximum: Int64 { Int64(maxMB) * 1024 * 1024 }
    private var maxMB: Int { defaults.object(forKey: "maxDownloadMB") == nil ? 500 : defaults.integer(forKey: "maxDownloadMB") }
    private func currentSettings() -> [String: Any] { ["directHosts": defaults.stringArray(forKey: "directHosts") ?? [], "maxDownloadMB": maxMB] }
    @objc func settings(_ call: CAPPluginCall) { work(call) { self.currentSettings() } }
    @objc func configure(_ call: CAPPluginCall) {
        work(call) {
            let hosts = call.getArray("directHosts", String.self) ?? [], max = call.getInt("maxDownloadMB") ?? 500
            guard (1...500).contains(max), hosts.count <= 30, hosts.allSatisfy(SafeHTTP.hostValid) else {
                throw MediaFailure("invalid_settings", "请填写小写精确域名，大小上限为 1–500 MB。")
            }
            self.state.lock(); let busy = self.downloadActive; self.state.unlock()
            if busy { throw MediaFailure("busy", "请等待当前传输完成后修改设置。") }
            self.defaults.set(hosts, forKey: "directHosts"); self.defaults.set(max, forKey: "maxDownloadMB")
            return self.currentSettings()
        }
    }
    @objc func request(_ call: CAPPluginCall) {
        work(call) {
            try self.throttle()
            let scope = call.getString("scope") ?? "", raw = call.getString("url") ?? ""
            guard ["xhsPage", "douyinPage", "douyinApi"].contains(scope) else { throw MediaFailure("invalid_scope", "请求类型无效。") }
            if scope == "douyinApi" && raw.range(of: #"^https://aweme\.snssdk\.com/aweme/v1/feed/\?aweme_id=[0-9]{15,22}&aid=1128$"#, options: .regularExpression) == nil {
                throw MediaFailure("invalid_item", "作品接口地址无效。")
            }
            let token = UUID().uuidString.lowercased(), operation = self.op(token, seconds: 20)
            defer { self.finish(token) }
            if scope != "douyinApi" {
                let page = try SafeHTTP.readPage(raw, hosts: self.allowed(scope), operation: operation)
                return ["body": page.body, "url": page.url]
            }
            let response = try SafeHTTP.open(raw, hosts: self.allowed(scope), page: false, operation: operation)
            guard ["application/json", "text/json"].contains(response.mime) else {
                throw MediaFailure("invalid_response", "平台没有返回可识别的公开数据。")
            }
            return ["body": try response.text(operation: operation), "url": response.url.absoluteString]
        }
    }
    @objc func probe(_ call: CAPPluginCall) {
        work(call) {
            try self.throttle()
            let token = UUID().uuidString.lowercased(), operation = self.op(token, seconds: 20)
            defer { self.finish(token) }
            let response = try SafeHTTP.open(call.getString("url") ?? "", hosts: self.allowed("media"), page: false, operation: operation)
            _ = try SafeHTTP.ext(response.mime)
            if let size = response.size, size > self.maximum { throw MediaFailure("too_large", "素材超过单文件大小上限。") }
            try SafeHTTP.signature(response.prefix(), mime: response.mime)
            try operation.check()
            return ["mime": response.mime, "size": response.size.map { $0 as Any } ?? NSNull()]
        }
    }
    @objc func prepare(_ call: CAPPluginCall) {
        work(call) {
            try self.throttle()
            self.state.lock()
            if self.downloadActive { self.state.unlock(); throw MediaFailure("busy", "请等待当前传输完成。") }
            self.downloadActive = true; self.state.unlock()
            let token = call.getString("operationId") ?? ""
            var part: URL?, completed: URL?, committed = false
            defer {
                self.finish(token)
                if let path = part { try? FileManager.default.removeItem(at: path) }
                if !committed, let path = completed { try? FileManager.default.removeItem(at: path) }
                self.state.lock(); self.downloadActive = false; self.state.unlock()
            }
            guard UUID(uuidString: token)?.uuidString.lowercased() == token else { throw MediaFailure("invalid_id", "任务编号无效。") }
            let operation = self.op(token, seconds: 300), store = self.store!
            try store.cleanup()
            if try store.used() + self.maximum > 2 * 1024 * 1024 * 1024 { throw MediaFailure("storage_limit", "本机素材额度为 2 GB，请先清理记录或降低单文件上限。") }
            let mime = call.getString("expectedMime") ?? "", id = UUID().uuidString.lowercased()
            let platform = call.getString("platform") ?? ""
            guard ["direct", "douyin", "xiaohongshu"].contains(platform) else { throw MediaFailure("invalid_platform", "素材平台无效。") }
            let title = String((call.getString("title") ?? "素材").filter { !$0.isNewline && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }.prefix(180))
            completed = try store.file(id, mime: mime); part = store.root.appendingPathComponent(id + ".part")
            guard FileManager.default.createFile(atPath: part!.path, contents: nil,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { throw MediaFailure("storage_error", "无法创建素材文件。") }
            let output = try FileHandle(forWritingTo: part!)
            defer { try? output.close() }
            let response = try SafeHTTP.open(call.getString("url") ?? "", hosts: self.allowed("media"), page: false, operation: operation)
            _ = try SafeHTTP.ext(mime)
            let expected: Int64?
            if let value = call.getDouble("expectedSize") {
                guard value.isFinite, value >= 0, value <= Double(self.maximum), value.rounded(.down) == value else {
                    throw MediaFailure("invalid_size", "素材大小无效或超过上限，请重新解析。")
                }
                expected = Int64(value)
            } else { expected = nil }
            guard response.mime == mime else { throw MediaFailure("source_changed", "素材类型已变化，请重新解析。") }
            if let length = response.size {
                if length > self.maximum { throw MediaFailure("too_large", "素材超过单文件大小上限。") }
                if let expected = expected, expected != length { throw MediaFailure("source_changed", "素材大小已变化，请重新解析。") }
            }
            let expectedMd5 = call.getString("expectedMd5")
            if let checksum = expectedMd5, checksum.range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) == nil {
                throw MediaFailure("invalid_checksum", "原片校验信息无效，请重新解析。")
            }
            var digest = Insecure.MD5()
            let prefix = try response.prefix(); try SafeHTTP.signature(prefix, mime: mime)
            var bytes = Int64(prefix.count), last = Date.distantPast
            if bytes > self.maximum { throw MediaFailure("too_large", "素材超过大小上限。") }
            try output.write(contentsOf: prefix)
            if expectedMd5 != nil { digest.update(data: prefix) }
            while true {
                try operation.check()
                let data = try response.read()
                if data.isEmpty { break }
                bytes += Int64(data.count)
                if bytes > self.maximum || response.size.map({ bytes > $0 }) == true { throw MediaFailure("too_large", "实际文件超过大小上限。") }
                try output.write(contentsOf: data)
                if expectedMd5 != nil { digest.update(data: data) }
                if Date().timeIntervalSince(last) > 0.2 {
                    last = Date()
                    self.notifyListeners("progress", data: ["operationId": token, "bytes": bytes,
                        "total": response.size.map { $0 as Any } ?? NSNull()])
                }
            }
            try operation.check()
            if response.size.map({ $0 != bytes }) == true || expected.map({ $0 != bytes }) == true {
                throw MediaFailure("incomplete_file", "文件传输不完整，已丢弃。")
            }
            if let expectedMd5 = expectedMd5,
               digest.finalize().map({ String(format: "%02x", $0) }).joined() != expectedMd5.lowercased() {
                throw MediaFailure("original_mismatch", "文件与平台公布的原片校验值不一致，已丢弃；不会保存可能带水印的替代版本。")
            }
            try output.synchronize(); try output.close()
            try FileManager.default.moveItem(at: part!, to: completed!)
            let record = try store.add(id: id, title: title, platform: platform, mime: mime, bytes: bytes, temporary: call.getBool("temporary") ?? true)
            committed = true; return record
        }
    }
    @objc func cancel(_ call: CAPPluginCall) {
        state.lock(); let operation = operations[call.getString("operationId") ?? ""]; state.unlock()
        operation?.cancel(); call.resolve()
    }
    @objc func list(_ call: CAPPluginCall) { work(call) { ["items": try self.store!.list()] } }
    @objc func promote(_ call: CAPPluginCall) { work(call) { try self.store!.promote(call.getString("id") ?? "") } }
    @objc func remove(_ call: CAPPluginCall) { work(call) { try self.store!.remove(call.getString("id") ?? ""); return [:] } }
    @objc func share(_ call: CAPPluginCall) {
        do {
            guard let store = store else { throw MediaFailure("storage_error", "本机存储不可用。") }
            let row = try store.get(call.getString("id") ?? ""), file = URL(string: row["path"] as! String)!
            DispatchQueue.main.async {
                guard let presenter = self.bridge?.viewController else { call.reject("分享界面不可用。"); return }
                let controller = UIActivityViewController(activityItems: [file], applicationActivities: nil)
                if let popover = controller.popoverPresentationController {
                    popover.sourceView = presenter.view; popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
                }
                presenter.present(controller, animated: true) { call.resolve() }
            }
        } catch { call.reject("本机文件不存在。") }
    }
    @objc func photos(_ call: CAPPluginCall) {
        do {
            guard let store = store else { throw MediaFailure("storage_error", "本机存储不可用。") }
            let row = try store.get(call.getString("id") ?? ""), file = URL(string: row["path"] as! String)!, mime = row["mime"] as! String
            guard ["video/mp4", "video/quicktime", "image/jpeg", "image/png", "image/gif", "image/webp"].contains(mime) else {
                throw MediaFailure("unsupported_export", "此格式请使用分享按钮导出。")
            }
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                guard status == .authorized || status == .limited else { call.reject("未获相册添加权限，仍可使用分享按钮保存到文件。", "permission_denied"); return }
                DispatchQueue.global(qos: .userInitiated).async {
                    do {
                        let export = try PhotoExport.prepare(file, mime: mime)
                        var created = false
                        PHPhotoLibrary.shared().performChanges({
                            if mime.hasPrefix("video/") { created = PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: export.url) != nil }
                            else { created = PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: export.url) != nil }
                        }) { success, _ in
                            if export.temporary { try? FileManager.default.removeItem(at: export.url) }
                            if success && created { call.resolve() } else { call.reject("无法保存到相册，请检查格式或使用分享导出。", "photos_failed") }
                        }
                    } catch let error as MediaFailure { call.reject(error.message, error.code) }
                    catch { call.reject("无法准备相册副本，请使用分享导出。", "photos_failed") }
                }
            }
        } catch let error as MediaFailure { call.reject(error.message, error.code) }
        catch { call.reject("本机文件不存在。") }
    }
}
