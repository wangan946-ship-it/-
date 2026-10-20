import XCTest
import Foundation
import SQLite3
@testable import App

private final class FragmentedChannel: MediaByteChannel {
    private var bytes: [UInt8]
    private let fragment: Int
    var reads = 0
    var failAtEOF = false
    init(_ text: String, fragment: Int = 1) {
        bytes = Array(text.utf8); self.fragment = fragment
    }
    func cancel() {}
    func read(_ count: Int) throws -> Data {
        reads += 1
        if bytes.isEmpty && failAtEOF { throw MediaFailure("network_error", "Connection remains open") }
        let n = min(count, min(fragment, bytes.count))
        let result = Data(bytes.prefix(n)); bytes.removeFirst(n); return result
    }
    func line(_ limit: Int) throws -> String {
        var result = Data()
        while result.count <= limit {
            guard let byte = try read(1).first else { throw MediaFailure("incomplete_file", "Truncated header") }
            if byte == 10 {
                guard result.last == 13 else { throw MediaFailure("invalid_response", "Invalid newline") }
                result.removeLast(); return String(decoding: result, as: UTF8.self)
            }
            result.append(byte)
        }
        throw MediaFailure("invalid_response", "Header limit")
    }
}

final class NativeTests: XCTestCase {
    private let trusted: Set<String> = ["cdn.example.com"]
    private func response(_ channel: FragmentedChannel, _ headers: [String: String]) -> SafeHTTP.Response {
        SafeHTTP.Response(url: URL(string: "https://cdn.example.com/a.mp4")!, headers: headers, channel: channel)
    }
    private func drain(_ response: SafeHTTP.Response) throws -> Data {
        var output = Data()
        while true {
            let chunk = try response.read()
            if chunk.isEmpty { return output }
            output.append(chunk)
        }
    }
    func testURLBoundary() throws {
        XCTAssertEqual(try SafeHTTP.validate("https://cdn.example.com/a.mp4?t=a%20b", hosts: trusted).host, "cdn.example.com")
        for raw in ["http://cdn.example.com/a", "https://cdn.example.com:8443/a",
                    "https://user:password@cdn.example.com/a", "https://cdn.example.com/a#fragment",
                    "https://127.0.0.1/a", "https://[::1]/a", "https://cdn.example.com.evil.test/a",
                    "https://cdn.example.com\\@evil.test/a", "https://cdn.example.com/a\r\nInjected: value"] {
            XCTAssertThrowsError(try SafeHTTP.validate(raw, hosts: trusted), raw)
        }
    }
    func testPrivateAndReservedIPv4() {
        let addresses: [[UInt8]] = [[0,0,0,0], [10,0,0,1], [127,0,0,1], [169,254,169,254],
                                   [172,16,0,1], [192,168,1,1], [100,64,0,1], [198,18,0,1],
                                   [192,0,2,1], [198,51,100,1], [203,0,113,1], [224,0,0,1]]
        for value in addresses {
            XCTAssertFalse(SafeHTTP.publicAddress(value))
        }
        XCTAssertTrue(SafeHTTP.publicAddress([1,1,1,1]))
    }
    func testPrivateAndReservedIPv6() {
        XCTAssertFalse(SafeHTTP.publicAddress(Array(repeating: 0, count: 16)))
        XCTAssertFalse(SafeHTTP.publicAddress([0xfc] + Array(repeating: 0, count: 15)))
        XCTAssertFalse(SafeHTTP.publicAddress([0xfe, 0x80] + Array(repeating: 0, count: 14)))
        XCTAssertFalse(SafeHTTP.publicAddress([0x20, 0x01, 0x0d, 0xb8] + Array(repeating: 0, count: 12)))
        XCTAssertTrue(SafeHTTP.publicAddress([0x26, 0x06, 0x47, 0x00] + Array(repeating: 0, count: 12)))
    }
    func testContentLengthDoesNotWaitForCDNToClose() throws {
        let channel = FragmentedChannel("abcdef", fragment: 2); channel.failAtEOF = true
        XCTAssertEqual(try drain(response(channel, ["content-length": "6"])), Data("abcdef".utf8))
        XCTAssertEqual(channel.reads, 3)
    }
    func testContentLengthStopsBeforeBytesOutsideBody() throws {
        let channel = FragmentedChannel("abcEXTRA", fragment: 1024)
        XCTAssertEqual(try drain(response(channel, ["content-length": "3"])), Data("abc".utf8))
    }
    func testTruncatedContentLengthFails() {
        XCTAssertThrowsError(try drain(response(FragmentedChannel("abc"), ["content-length": "6"])))
    }
    func testFragmentedChunkedBody() throws {
        let input = "4;test=yes\r\nWiki\r\n5\r\npedia\r\n0\r\nX-Final: yes\r\n\r\n"
        XCTAssertEqual(try drain(response(FragmentedChannel(input), ["transfer-encoding": "chunked"])), Data("Wikipedia".utf8))
    }
    func testMalformedAndTruncatedChunksFail() {
        for input in ["Z\r\n", "3\r\nab", "3\r\nabcX\r\n0\r\n\r\n", "0\r\nunfinished"] {
            XCTAssertThrowsError(try drain(response(FragmentedChannel(input), ["transfer-encoding": "chunked"])))
        }
    }
    func testPageSizeAndEncodingLimits() {
        let op = MediaOperation(seconds: 10)
        XCTAssertThrowsError(try response(FragmentedChannel(""), ["content-length": "2097153"]).text(operation: op))
        XCTAssertEqual(try? response(FragmentedChannel("hello"), ["content-length": "5"]).text(operation: op), "hello")
    }
    func testHTMLCannotBeSavedAsVideo() {
        XCTAssertThrowsError(try SafeHTTP.signature(Data("<html>blocked</html>".utf8), mime: "video/mp4"))
        XCTAssertThrowsError(try SafeHTTP.ext("text/html"))
        XCTAssertNoThrow(try SafeHTTP.signature(Data([0,0,0,24] + Array("ftypisom".utf8)), mime: "video/mp4"))
    }
    func testCancellationAndDeadline() {
        let cancelled = MediaOperation(seconds: 20); cancelled.cancel()
        XCTAssertThrowsError(try cancelled.check()) { XCTAssertEqual(($0 as? MediaFailure)?.code, "cancelled") }
        XCTAssertThrowsError(try MediaOperation(seconds: -1).check()) { XCTAssertEqual(($0 as? MediaFailure)?.code, "timeout") }
    }
    func testAnonymousVisitorIsScopedToOnePublicWork() {
        let page = URL(string: "https://www.iesdouyin.com/share/video/7666481628718787003/")!
        let session = SafeHTTP.VisitorSession()
        session.accept(page, header: "sessionid=account-secret; Path=/; Secure")
        XCTAssertEqual(session.header(page), "")
        session.accept(page, header: "ttwid=anonymous-test; Path=/; Secure")
        XCTAssertFalse(session.header(page).isEmpty)
        XCTAssertEqual(session.header(URL(string: "https://www.iesdouyin.com/share/video/7666481628718787004/")!), "")
        XCTAssertEqual(session.header(URL(string: "https://other.example.com/")!), "")
        session.clear(); XCTAssertEqual(session.header(page), "")
    }
    func testMediaStoreLifecycleAndRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = UUID().uuidString.lowercased()
        do {
            let store = try MediaStore(directory: directory)
            try Data([1,2,3]).write(to: store.file(id, mime: "image/png"))
            _ = try store.add(id: id, title: "原片测试", platform: "direct", mime: "image/png", bytes: 3, temporary: true)
            XCTAssertTrue(try store.list().isEmpty)
            XCTAssertEqual(try store.used(), 3)
            _ = try store.promote(id)
            XCTAssertEqual(try store.list().count, 1)
            try Data([0]).write(to: store.root.appendingPathComponent("unfinished.part"))
        }
        let reopened = try MediaStore(directory: directory)
        XCTAssertEqual(try reopened.list().first?["title"] as? String, "原片测试")
        XCTAssertFalse(FileManager.default.fileExists(atPath: reopened.root.appendingPathComponent("unfinished.part").path))
        XCTAssertThrowsError(try reopened.file("../escape", mime: "image/png"))
        try reopened.remove(id)
        XCTAssertTrue(try reopened.list().isEmpty)
        XCTAssertEqual(try reopened.used(), 0)
    }
    func testMissingFilesAreRemovedFromHistory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try MediaStore(directory: directory), id = UUID().uuidString.lowercased()
        let file = try store.file(id, mime: "image/png")
        try Data([0]).write(to: file)
        _ = try store.add(id: id, title: "test", platform: "direct", mime: "image/png", bytes: 1, temporary: false)
        try FileManager.default.removeItem(at: file)
        XCTAssertTrue(try store.list().isEmpty)
    }
    func testInvalidWebPAndUnsupportedFormatsCannotCreateAlbumCopies() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".webp")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data("<html>access denied</html>".utf8).write(to: file)
        XCTAssertThrowsError(try PhotoExport.prepare(file, mime: "image/webp"))
        XCTAssertThrowsError(try PhotoExport.prepare(file, mime: "video/webm"))
    }
}
