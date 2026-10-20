import XCTest
import WebKit
import UIKit
import CryptoKit
@testable import App

final class BridgeTests: XCTestCase {
    @MainActor private func webView() async throws -> WKWebView {
        for _ in 0..<150 {
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
            if let controller = windows.compactMap({ $0.rootViewController as? LocalViewController }).first,
               let web = controller.webView,
               (try? await script(web, "return !!document.querySelector('#share-text') && !!window.Capacitor?.nativePromise;")) as? Bool == true {
                return web
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        throw MediaFailure("test_startup", "App page or native bridge did not start within 30 seconds")
    }
    @MainActor private func script(_ web: WKWebView, _ source: String, arguments: [String: Any] = [:]) async throws -> Any {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Any, Error>) in
            web.callAsyncJavaScript(source, arguments: arguments, in: nil, in: .page) { result in
                continuation.resume(with: result)
            }
        }
    }
    @MainActor private func bridge(_ web: WKWebView, _ method: String, _ options: [String: Any] = [:]) async throws -> Any {
        try await script(web, "return await window.Capacitor.nativePromise('LocalMedia', method, options);",
                         arguments: ["method": method, "options": options])
    }
    @MainActor func testNativeBridgeSettingsAndURLRejection() async throws {
        let web = try await webView()
        let settings = try await bridge(web, "settings") as? [String: Any]
        XCTAssertNotNil(settings?["maxDownloadMB"])
        let result = try await script(web, """
            try { await window.Capacitor.nativePromise('LocalMedia','probe',{url:'https://127.0.0.1/a.mp4'}); return 'unexpected-success'; }
            catch (error) { return error.code; }
            """)
        XCTAssertEqual(result as? String, "unsafe_url")
    }
    @MainActor func testLocalFilePreviewPhotosAndShare() async throws {
        let web = try await webView(), store = try MediaStore(), id = UUID().uuidString.lowercased()
        defer { try? store.remove(id) }
        let file = try store.file(id, mime: "image/png")
        let png = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).pngData { context in
            UIColor.blue.setFill(); context.fill(CGRect(x: 0, y: 0, width: 32, height: 32))
        }
        try png.write(to: file)
        _ = try store.add(id: id, title: "iOS simulator export test", platform: "direct",
                          mime: "image/png", bytes: Int64(png.count), temporary: false)
        let preview = try await script(web, """
            const image = new Image();
            const ready = new Promise((resolve,reject) => {
              image.onload = () => resolve(image.naturalWidth);
              image.onerror = () => reject(new Error('local image preview failed'));
              setTimeout(() => reject(new Error('local image preview timeout')), 10000);
            });
            image.src = window.Capacitor.convertFileSrc(path);
            return await ready;
            """, arguments: ["path": file.absoluteString])
        XCTAssertEqual((preview as? NSNumber)?.intValue, 32)
        // The isolated simulator is pre-authorized by the CI script. No real
        // photo library is touched: these tests are never run on a phone by CI.
        _ = try await bridge(web, "photos", ["id": id])
        _ = try await bridge(web, "share", ["id": id])
        let presenter = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }.compactMap { $0.rootViewController as? LocalViewController }.first
        XCTAssertTrue(presenter?.presentedViewController is UIActivityViewController)
        presenter?.dismiss(animated: false)
        _ = try await bridge(web, "remove", ["id": id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
    @MainActor private func importAndSave(_ web: WKWebView, share: String, video: Bool) async throws -> [String: Any] {
        let value = try await script(web, """
            const wait = async (predicate, seconds) => {
              const end = Date.now() + seconds * 1000;
              while (Date.now() < end) {
                const value = predicate(); if (value) return value;
                const error = document.querySelector('.error');
                if (error) throw new Error(error.textContent);
                await new Promise(r => setTimeout(r, 200));
              }
              throw new Error('iOS end-to-end timeout');
            };
            const field = document.querySelector('#share-text');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, share);
            field.dispatchEvent(new Event('input', { bubbles:true }));
            await new Promise(r => setTimeout(r, 0));
            const parse = await wait(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '解析素材' && !b.disabled), 10);
            parse.click();
            await wait(() => document.querySelector('[aria-label="解析结果"] .asset'), 90);
            const button = [...document.querySelectorAll('.asset button')].find(b => b.textContent.includes(video ? '下载视频到本机' : '下载图片到本机'));
            if (!button) throw new Error('wrong media type');
            button.click();
            await wait(() => [...document.querySelectorAll('.asset button')].some(b => b.textContent.includes('已保存到本机')), 310);
            if (video) {
              const player = document.querySelector('.asset video');
              await wait(() => player && player.readyState >= 2 && player.videoWidth > 0, 30);
              player.muted = true;
              await player.play();
              await wait(() => player.currentTime > 0, 10);
              player.pause();
            } else {
              await wait(() => { const image = document.querySelector('.asset img'); return image?.complete && image.naturalWidth > 0; }, 20);
            }
            const records = (await window.Capacitor.nativePromise('LocalMedia', 'list', {})).items;
            return records.sort((a,b) => b.createdAt-a.createdAt)[0];
            """, arguments: ["share": share, "video": video])
        return try XCTUnwrap(value as? [String: Any])
    }
    @MainActor func testLiveXiaohongshuOriginalPlaybackAndPhotos() async throws {
        guard ProcessInfo.processInfo.environment["LIUYING_LIVE_NETWORK"] == "1" else {
            throw XCTSkip("Live platform verification was not requested; no candidate IPA may be released.")
        }
        let web = try await webView()
        let row = try await importAndSave(web, share: "https://xhslink.cn/o/5DgIAnhxxhB", video: true)
        let id = try XCTUnwrap(row["id"] as? String), path = try XCTUnwrap(row["path"] as? String)
        defer { try? MediaStore().remove(id) }
        let data = try Data(contentsOf: XCTUnwrap(URL(string: path)))
        XCTAssertEqual(data.count, 15_269_927)
        XCTAssertEqual(Insecure.MD5.hash(data: data).map { String(format: "%02x", $0) }.joined(), "d9a61a4b9b72890fdf059d21fedffafa")
        XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "7fde256caaa12ffadbbb8564525b4d5cd49fe5f3c17c74c8d8f3f40ad5aabf53")
        _ = try await bridge(web, "photos", ["id": id])
    }
    @MainActor func testLiveDouyinExactWorkAndImagePreview() async throws {
        guard ProcessInfo.processInfo.environment["LIUYING_LIVE_NETWORK"] == "1" else {
            throw XCTSkip("Live platform verification was not requested.")
        }
        let web = try await webView()
        let row = try await importAndSave(web, share: "https://v.douyin.com/CyXS6O9dtUM/", video: false)
        let id = try XCTUnwrap(row["id"] as? String)
        defer { try? MediaStore().remove(id) }
        XCTAssertEqual(row["title"] as? String, "就是这样变脸")
        XCTAssertEqual(row["mime"] as? String, "image/webp")
        XCTAssertEqual((row["bytes"] as? NSNumber)?.intValue, 136_566)
        _ = try await bridge(web, "photos", ["id": id])
    }
    @MainActor func testLiveDouyinVideoPlaybackAndPhotos() async throws {
        guard ProcessInfo.processInfo.environment["LIUYING_LIVE_NETWORK"] == "1" else {
            throw XCTSkip("Live platform verification was not requested.")
        }
        let web = try await webView()
        let row = try await importAndSave(web, share: "https://www.douyin.com/video/6961737553342991651", video: true)
        let id = try XCTUnwrap(row["id"] as? String), path = try XCTUnwrap(row["path"] as? String)
        defer { try? MediaStore().remove(id) }
        let data = try Data(contentsOf: XCTUnwrap(URL(string: path)))
        XCTAssertEqual(data.count, 3_676_544)
        XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "af479be42a1f90e57b9305a57807732393324c62c8fa80930780fea023f13881")
        _ = try await bridge(web, "photos", ["id": id])
    }
}
