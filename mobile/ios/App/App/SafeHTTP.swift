import Foundation
import Network
import Security
import Darwin

struct MediaFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

// The response decoder also runs against fragmented, in-memory streams in XCTest.
protocol MediaByteChannel {
    func read(_ count: Int) throws -> Data
    func line(_ limit: Int) throws -> String
    func cancel()
}

final class MediaOperation {
    private let lock = NSLock()
    private var connection: NWConnection?
    private var cancelled = false
    let deadline: Date
    init(seconds: TimeInterval) { deadline = Date().addingTimeInterval(seconds) }
    func check() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        if stopped { throw MediaFailure("cancelled", "操作已取消。") }
        if Date() > deadline { throw MediaFailure("timeout", "获取素材超时，已停止。") }
    }
    func attach(_ connection: NWConnection) throws {
        lock.lock()
        if cancelled { lock.unlock(); connection.cancel(); throw MediaFailure("cancelled", "操作已取消。") }
        self.connection = connection; lock.unlock()
    }
    func cancel() {
        lock.lock(); cancelled = true; let current = connection; lock.unlock()
        current?.cancel()
    }
}

enum SafeHTTP {
    private static let dnsSlots = DispatchSemaphore(value: 2)
    private final class DNSResult {
        let lock = NSLock()
        var value: Result<[String], Error>?
    }
    static let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"
    // An official anonymous visitor cookie, scoped to one readPage operation.
    // Never read HTTPCookieStorage, WKWebView cookies or any account session.
    final class VisitorSession {
        private var host: String?, path: String?, value: String?
        static func sharePage(_ url: URL) -> Bool {
            url.scheme == "https" && ["www.iesdouyin.com", "iesdouyin.com"].contains(url.host ?? "") &&
            url.path.range(of: #"^/share/(?:video|note|slides)/[0-9]{15,22}/?$"#, options: .regularExpression) != nil
        }
        func accept(_ url: URL, header: String) {
            guard Self.sharePage(url), header.utf8.count <= 4096,
                  !header.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return }
            for cookie in HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url) {
                guard cookie.name == "ttwid", cookie.expiresDate == nil || cookie.expiresDate! > Date(),
                      cookie.value.range(of: #"^[A-Za-z0-9%._|~+\-]{1,1024}$"#, options: .regularExpression) != nil,
                      [url.host!, "." + url.host!, "iesdouyin.com", ".iesdouyin.com"].contains(cookie.domain),
                      cookie.path == "/" || cookie.path == url.path else { continue }
                host = url.host; path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
                value = cookie.value
            }
        }
        func header(_ url: URL) -> String {
            guard let value = value, Self.sharePage(url), url.host == host,
                  URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath == path else { return "" }
            return "Cookie: ttwid=\(value)\r\n"
        }
        func clear() { host = nil; path = nil; value = nil }
    }
    static func readPage(_ raw: String, hosts: Set<String>, operation: MediaOperation) throws -> (url: String, body: String) {
        let visitor = VisitorSession()
        defer { visitor.clear() }
        var current = raw
        for attempt in 0..<2 {
            let response = try open(current, hosts: hosts, page: true, operation: operation, visitor: visitor)
            let body: String
            do {
                defer { response.channel.cancel() }
                guard ["text/html", "application/xhtml+xml"].contains(response.mime) else {
                    throw MediaFailure("invalid_response", "平台没有返回可识别的公开页面。")
                }
                body = try response.text(operation: operation)
            }
            if attempt == 0 && !visitor.header(response.url).isEmpty &&
                body.contains("_ROUTER_DATA") && !body.contains("\"videoInfoRes\"") {
                current = response.url.absoluteString
            } else { return (response.url.absoluteString, body) }
        }
        throw MediaFailure("invalid_response", "平台没有返回可识别的公开页面。")
    }
    static func hostValid(_ host: String) -> Bool {
        host.count <= 253 && host.contains(".") && !host.contains("..") &&
        host.range(of: #"^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$"#, options: .regularExpression) != nil &&
        host.range(of: #"^[0-9.]+$"#, options: .regularExpression) == nil
    }
    static func validate(_ raw: String, hosts: Set<String>) throws -> URL {
        guard raw.utf8.count <= 4096, !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || $0.value == 92 }),
              let parts = URLComponents(string: raw), parts.scheme == "https", parts.user == nil, parts.password == nil,
              parts.fragment == nil, parts.port == nil || parts.port == 443,
              let host = parts.host, hostValid(host), let url = parts.url else {
            throw MediaFailure("unsafe_url", "仅支持 HTTPS 公网域名，不接受 IP、凭证或特殊端口。")
        }
        guard hosts.contains(host) else { throw MediaFailure("host_not_allowed", "媒体域名未获允许，请核实设置。") }
        return url
    }
    static func publicAddress(_ b: [UInt8]) -> Bool {
        if b.count == 4 {
            let a = Int(b[0]), n = Int(b[1]), c = Int(b[2])
            return !(a == 0 || a == 10 || a == 127 || a >= 224 || (a == 100 && (64...127).contains(n)) ||
                (a == 169 && n == 254) || (a == 172 && (16...31).contains(n)) ||
                (a == 192 && (n == 168 || n == 0 || (n == 88 && c == 99))) ||
                (a == 198 && (n == 18 || n == 19 || (n == 51 && c == 100))) || (a == 203 && n == 0 && c == 113))
        }
        guard b.count == 16, b[0] & 0xe0 == 0x20 else { return false }
        let second = Int(b[2]) * 256 + Int(b[3])
        if b[0] == 0x20 && b[1] == 0x01 && (second < 0x0200 || second == 0x0db8) { return false }
        if b[0] == 0x20 && b[1] == 0x02 { return false }
        return !(b[0] == 0x3f && b[1] == 0xff && b[2] & 0xf0 == 0)
    }
    static func addresses(_ host: String) throws -> [String] {
        guard dnsSlots.wait(timeout: .now()) == .success else {
            throw MediaFailure("busy", "域名解析繁忙，请稍后重试。")
        }
        let box = DNSResult(), done = DispatchSemaphore(value: 0)
        DispatchQueue.global(qos: .userInitiated).async {
            defer { dnsSlots.signal(); done.signal() }
            let result = Result { try resolveAddresses(host) }
            box.lock.lock(); box.value = result; box.lock.unlock()
        }
        guard done.wait(timeout: .now() + 10) == .success else {
            throw MediaFailure("dns_failed", "域名解析超时，已停止。")
        }
        box.lock.lock(); let result = box.value; box.lock.unlock()
        guard let result = result else { throw MediaFailure("dns_failed", "无法解析来源域名。") }
        return try result.get()
    }
    private static func resolveAddresses(_ host: String) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, "443", &hints, &result) == 0, let first = result else {
            throw MediaFailure("dns_failed", "无法解析来源域名。")
        }
        defer { freeaddrinfo(first) }
        var next: UnsafeMutablePointer<addrinfo>? = first
        var strings = [String]()
        while let item = next {
            let value = item.pointee
            let bytes: [UInt8]
            if value.ai_family == AF_INET {
                var address = value.ai_addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr }
                bytes = withUnsafeBytes(of: &address) { Array($0) }
            } else if value.ai_family == AF_INET6 {
                var address = value.ai_addr.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { $0.pointee.sin6_addr }
                bytes = withUnsafeBytes(of: &address) { Array($0) }
            } else { throw MediaFailure("blocked_address", "来源地址类型不受支持。") }
            var numeric = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(value.ai_addr, value.ai_addrlen, &numeric, socklen_t(numeric.count), nil, 0, NI_NUMERICHOST) == 0 else {
                throw MediaFailure("dns_failed", "来源地址无法识别。")
            }
            guard publicAddress(bytes) else {
                #if DEBUG
                if ProcessInfo.processInfo.environment["LIUYING_LIVE_NETWORK"] == "1" {
                    // QA diagnostics contain only host/IP, never paths,
                    // signed query parameters, responses or visitor cookies.
                    print("Liuying QA DNS rejected host=\(host) address=\(String(cString: numeric))")
                }
                #endif
                throw MediaFailure("blocked_address", "来源包含内网或保留地址，已拒绝访问。")
            }
            strings.append(String(cString: numeric)); next = value.ai_next
        }
        // Prefer IPv4 when available; every returned address is still validated.
        return Array(Set(strings)).sorted { ($0.contains(":") ? 1 : 0, $0) < ($1.contains(":") ? 1 : 0, $1) }
    }
    static func ext(_ mime: String) throws -> String {
        guard let value = ["video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm",
                           "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"][mime] else {
            throw MediaFailure("unsupported_type", "仅支持 MP4、MOV、WebM、JPG、PNG、WebP、GIF 文件。")
        }
        return value
    }
    static func signature(_ data: Data, mime: String) throws {
        let b = [UInt8](data)
        func ascii(_ range: Range<Int>) -> String { String(bytes: b[range], encoding: .ascii) ?? "" }
        let valid: Bool
        switch mime {
        case "video/mp4", "video/quicktime": valid = b.count >= 12 && ascii(4..<8) == "ftyp"
        case "video/webm": valid = Array(b.prefix(4)) == [0x1a, 0x45, 0xdf, 0xa3]
        case "image/jpeg": valid = Array(b.prefix(3)) == [255,216,255]
        case "image/png": valid = Array(b.prefix(8)) == [137,80,78,71,13,10,26,10]
        case "image/webp": valid = b.count >= 12 && ascii(0..<4) == "RIFF" && ascii(8..<12) == "WEBP"
        case "image/gif": valid = b.count >= 6 && ["GIF87a", "GIF89a"].contains(ascii(0..<6))
        default: valid = false
        }
        if !valid { throw MediaFailure("invalid_media", "文件特征与媒体类型不符，已拒绝。") }
    }

    final class Channel: MediaByteChannel {
        let connection: NWConnection
        let operation: MediaOperation
        private let queue = DispatchQueue(label: "liuying.tls")
        private var buffer = Data()
        private var ended = false
        init(host: String, ip: String, operation: MediaOperation) throws {
            self.operation = operation
            let tls = NWProtocolTLS.Options()
            sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, host)
            sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
            // Validate the normal system trust chain AND the original hostname,
            // although the socket connects to an already-checked numeric address.
            sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, peerTrust, complete in
                let trust = sec_trust_copy_ref(peerTrust).takeRetainedValue()
                SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
                complete(SecTrustEvaluateWithError(trust, nil))
            }, queue)
            let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
            connection = NWConnection(host: NWEndpoint.Host(ip), port: 443, using: parameters)
            try operation.attach(connection)
            let ready = DispatchSemaphore(value: 0)
            var success = false
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: success = true; ready.signal()
                case .failed, .cancelled: ready.signal()
                default: break
                }
            }
            connection.start(queue: queue)
            if ready.wait(timeout: .now() + 10) == .timedOut || !success {
                connection.cancel()
                throw MediaFailure("tls_or_network_error", "无法安全连接来源，请检查网络和证书。")
            }
            connection.stateUpdateHandler = nil
        }
        deinit { connection.cancel() }
        func cancel() { connection.cancel() }
        func send(_ data: Data) throws {
            try operation.check()
            let done = DispatchSemaphore(value: 0); var failure: NWError?
            connection.send(content: data, completion: .contentProcessed { error in failure = error; done.signal() })
            guard done.wait(timeout: .now() + 20) == .success, failure == nil else {
                connection.cancel(); throw MediaFailure("network_error", "发送请求失败。")
            }
        }
        private func receive() throws {
            try operation.check()
            let done = DispatchSemaphore(value: 0)
            var received: Data?; var complete = false; var failure: NWError?
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                received = data; complete = isComplete; failure = error; done.signal()
            }
            guard done.wait(timeout: .now() + 20) == .success, failure == nil else {
                connection.cancel(); throw MediaFailure("network_error", "素材读取中断或超时。")
            }
            if let data = received { buffer.append(data) }
            ended = complete
        }
        func read(_ count: Int) throws -> Data {
            if buffer.isEmpty && !ended { try receive() }
            let take = min(count, buffer.count), value = Data(buffer.prefix(take))
            buffer.removeFirst(take); return value
        }
        func line(_ limit: Int) throws -> String {
            var result = Data()
            while result.count <= limit {
                let b = try read(1)
                guard let byte = b.first else { throw MediaFailure("incomplete_file", "响应头传输中断。") }
                if byte == 10 {
                    guard result.last == 13 else { throw MediaFailure("invalid_response", "来源响应格式无效。") }
                    result.removeLast()
                    return String(data: result, encoding: .isoLatin1) ?? ""
                }
                result.append(byte)
            }
            throw MediaFailure("invalid_response", "来源响应头过大。")
        }
    }
    final class Response {
        let url: URL
        let headers: [String: String]
        let channel: MediaByteChannel
        private var received: Int64 = 0
        private var chunkLeft = 0
        private var chunkNewline = false
        private var ended = false
        var mime: String { (headers["content-type"] ?? "").components(separatedBy: ";")[0].trimmingCharacters(in: .whitespaces).lowercased() }
        var size: Int64? { headers["content-length"].flatMap(Int64.init) }
        init(url: URL, headers: [String: String], channel: MediaByteChannel) { self.url = url; self.headers = headers; self.channel = channel }
        func read(_ count: Int = 65536) throws -> Data {
            if ended { return Data() }
            if headers["transfer-encoding"] == nil {
                // Content-Length frames the body. Waiting for a TLS close after
                // the last byte can incorrectly time out on keep-alive CDNs.
                if let size = size, received == size { ended = true; return Data() }
                let wanted = size.map { Int(min(Int64(count), $0 - received)) } ?? count
                let data = try channel.read(wanted)
                if data.isEmpty, let size = size, received < size {
                    throw MediaFailure("incomplete_file", "来源传输不完整。")
                }
                received += Int64(data.count)
                if data.isEmpty { ended = true }
                return data
            }
            if chunkLeft == 0 {
                if chunkNewline {
                    if try channel.line(2) != "" { throw MediaFailure("invalid_response", "分块响应无效。") }
                }
                let line = try channel.line(128).components(separatedBy: ";")[0]
                guard line.range(of: "^[0-9a-fA-F]{1,15}$", options: .regularExpression) != nil,
                      let length = Int(line, radix: 16) else { throw MediaFailure("invalid_response", "分块大小无效。") }
                chunkLeft = length
                if length == 0 {
                    var total = 0
                    while true {
                        let trailer = try channel.line(8192); total += trailer.count
                        if total > 32768 { throw MediaFailure("invalid_response", "响应尾部过大。") }
                        if trailer.isEmpty { break }
                    }
                    ended = true; return Data()
                }
                chunkNewline = true
            }
            let data = try channel.read(min(count, chunkLeft))
            if data.isEmpty { throw MediaFailure("incomplete_file", "分块响应被截断。") }
            chunkLeft -= data.count; return data
        }
        func prefix() throws -> Data {
            var bytes = Data()
            while bytes.count < 64 {
                let next = try read(64 - bytes.count)
                if next.isEmpty { break }; bytes.append(next)
            }
            return bytes
        }
        func text(operation: MediaOperation) throws -> String {
            let max = 2 * 1024 * 1024
            if let size = size, size > max { throw MediaFailure("too_large", "平台页面超过读取上限。") }
            var data = Data()
            while true {
                try operation.check()
                let next = try read()
                if next.isEmpty { break }
                if data.count + next.count > max { throw MediaFailure("too_large", "平台页面超过读取上限。") }
                data.append(next)
            }
            if let size = size, size != data.count { throw MediaFailure("incomplete_file", "平台响应不完整。") }
            guard let text = String(data: data, encoding: .utf8) else { throw MediaFailure("invalid_response", "平台响应编码无效。") }
            return text
        }
    }
    static func open(_ raw: String, hosts: Set<String>, page: Bool, operation: MediaOperation,
                     visitor: VisitorSession? = nil) throws -> Response {
        var current = raw
        for hop in 0...5 {
            let url = try validate(current, hosts: hosts)
            if page && url.path.lowercased().range(of: "login|signin|captcha|verify|verification|/404|/error", options: .regularExpression) != nil {
                throw MediaFailure("access_denied", "链接要求登录、验证或已失效。")
            }
            try operation.check()
            let addresses = try addresses(url.host!)
            guard let ip = addresses.first else { throw MediaFailure("dns_failed", "域名没有可用地址。") }
            let channel = try Channel(host: url.host!, ip: ip, operation: operation)
            var keep = false
            defer { if !keep { channel.connection.cancel() } }
            let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            let target = (parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath) +
                (parts.percentEncodedQuery.map { "?" + $0 } ?? "")
            let request = "GET \(target) HTTP/1.1\r\nHost: \(url.host!)\r\nUser-Agent: \(ua)\r\nAccept: */*\r\nAccept-Encoding: identity\r\n" +
                (visitor?.header(url) ?? "") + "Connection: close\r\n\r\n"
            try channel.send(Data(request.utf8))
            let statusLine = try channel.line(4096)
            guard statusLine.range(of: #"^HTTP/1\.[01] [0-9]{3}(?: .*|)$"#, options: .regularExpression) != nil,
                  let status = Int(statusLine.split(separator: " ")[1]) else { throw MediaFailure("invalid_response", "来源响应无效。") }
            var headers = [String: String](), total = 0
            while true {
                let line = try channel.line(8192); total += line.count
                if total > 32768 { throw MediaFailure("invalid_response", "来源响应头过大。") }
                if line.isEmpty { break }
                guard !line.hasPrefix(" "), !line.hasPrefix("\t"), let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
                    throw MediaFailure("invalid_response", "来源响应头无效。")
                }
                let key = String(line[..<colon]).lowercased(), value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
                if key == "set-cookie" {
                    visitor?.accept(url, header: value)
                    continue
                }
                if headers[key] != nil && ["content-length", "transfer-encoding", "location", "content-type"].contains(key) {
                    throw MediaFailure("invalid_response", "来源响应头存在歧义。")
                }
                headers[key] = value
            }
            if [301,302,303,307,308].contains(status) {
                guard hop < 5, let location = headers["location"], let next = URL(string: location, relativeTo: url)?.absoluteURL else {
                    throw MediaFailure("redirect_limit", "来源重定向无效或过多。")
                }
                current = next.absoluteString; continue
            }
            guard status == 200 else { throw MediaFailure("source_denied", "来源未允许访问（HTTP \(status)）。") }
            if let length = headers["content-length"], Int64(length) == nil || (Int64(length) ?? -1) < 0 {
                throw MediaFailure("invalid_response", "来源大小无效。")
            }
            if let transfer = headers["transfer-encoding"], transfer.lowercased() != "chunked" || headers["content-length"] != nil {
                throw MediaFailure("invalid_response", "来源传输格式无效。")
            }
            guard (headers["content-encoding"] ?? "identity").lowercased() == "identity" else {
                throw MediaFailure("encoded_response", "不接受压缩的媒体或页面响应。")
            }
            keep = true
            return Response(url: url, headers: headers, channel: channel)
        }
        throw MediaFailure("redirect_limit", "来源重定向过多。")
    }
}
