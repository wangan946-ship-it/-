import Foundation
import SQLite3

final class MediaStore {
    let root: URL
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()
    init(directory testDirectory: URL? = nil) throws {
        let support = try testDirectory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var directory = testDirectory ?? support.appendingPathComponent("Liuying", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        root = directory.appendingPathComponent("media", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        guard sqlite3_open(directory.appendingPathComponent("records.sqlite").path, &db) == SQLITE_OK else {
            throw MediaFailure("storage_error", "本机数据库无法打开。")
        }
        try execute("CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,title TEXT NOT NULL,platform TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,created INTEGER NOT NULL,temporary INTEGER NOT NULL)")
        // Startup only: no active transfers exist when orphan files are removed.
        let known = Set(try rows("SELECT * FROM media").compactMap { row -> String? in
            guard let id = row["id"] as? String, let mime = row["mime"] as? String else { return nil }
            return try? file(id, mime: mime).lastPathComponent
        })
        for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            where !known.contains(url.lastPathComponent) { try? FileManager.default.removeItem(at: url) }
        try cleanup()
    }
    deinit { sqlite3_close(db) }
    private func statement(_ sql: String, _ bindings: [String]) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let value = stmt else {
            throw MediaFailure("storage_error", "本机数据库操作失败。")
        }
        for (i, binding) in bindings.enumerated() {
            let code = binding.withCString { sqlite3_bind_text(value, Int32(i + 1), $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
            if code != SQLITE_OK { sqlite3_finalize(value); throw MediaFailure("storage_error", "本机数据库写入失败。") }
        }
        return value
    }
    private func execute(_ sql: String, _ bindings: [String] = []) throws {
        let stmt = try statement(sql, bindings); defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw MediaFailure("storage_error", "本机数据库写入失败。") }
    }
    private func rows(_ sql: String, _ bindings: [String] = []) throws -> [[String: Any]] {
        let stmt = try statement(sql, bindings); defer { sqlite3_finalize(stmt) }
        var result = [[String: Any]]()
        var code = sqlite3_step(stmt)
        while code == SQLITE_ROW {
            func text(_ col: Int32) -> String { String(cString: sqlite3_column_text(stmt, col)) }
            result.append(["id": text(0), "title": text(1), "platform": text(2), "mime": text(3),
                           "bytes": sqlite3_column_int64(stmt, 4), "createdAt": sqlite3_column_int64(stmt, 5),
                           "temporary": sqlite3_column_int(stmt, 6) == 1])
            code = sqlite3_step(stmt)
        }
        if code != SQLITE_DONE { throw MediaFailure("storage_error", "本机数据库读取失败。") }
        return result
    }
    func file(_ id: String, mime: String) throws -> URL {
        guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw MediaFailure("invalid_id", "文件编号无效。") }
        return root.appendingPathComponent(id + (try SafeHTTP.ext(mime)))
    }
    func get(_ id: String) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard var row = try rows("SELECT * FROM media WHERE id=?", [id]).first,
              let mime = row["mime"] as? String else { throw MediaFailure("missing_file", "本机文件不存在或临时预览已清理。") }
        let url = try file(id, mime: mime)
        guard FileManager.default.fileExists(atPath: url.path) else { throw MediaFailure("missing_file", "本机文件已丢失，请重新下载。") }
        row["path"] = url.absoluteString; return row
    }
    func add(id: String, title: String, platform: String, mime: String, bytes: Int64, temporary: Bool) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard try rows("SELECT * FROM media LIMIT 500").count < 500 else {
            throw MediaFailure("record_limit", "本机最多保留 500 份素材，请先删除部分记录。")
        }
        try execute("INSERT INTO media VALUES(?,?,?,?,?,?,?)", [id, title, platform, mime, String(bytes),
            String(Int64(Date().timeIntervalSince1970 * 1000)), temporary ? "1" : "0"])
        return try get(id)
    }
    func cleanup() throws {
        lock.lock(); defer { lock.unlock() }
        for row in try rows("SELECT * FROM media") {
            let id = row["id"] as! String, path = try file(id, mime: row["mime"] as! String)
            let old = row["temporary"] as! Bool && Date().timeIntervalSince1970 * 1000 - Double(row["createdAt"] as! Int64) > 3_600_000
            if old || !FileManager.default.fileExists(atPath: path.path) { try remove(id) }
        }
    }
    func used() throws -> Int64 {
        lock.lock(); defer { lock.unlock() }
        return try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.fileSizeKey])
            .reduce(0) { total, url in total + Int64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) }
    }
    func list() throws -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        try cleanup()
        return try rows("SELECT * FROM media WHERE temporary=0 ORDER BY created DESC LIMIT 500").map { try get($0["id"] as! String) }
    }
    func promote(_ id: String) throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        _ = try get(id); try execute("UPDATE media SET temporary=0 WHERE id=?", [id]); return try get(id)
    }
    func remove(_ id: String) throws {
        lock.lock(); defer { lock.unlock() }
        if let row = try rows("SELECT * FROM media WHERE id=?", [id]).first {
            let url = try file(id, mime: row["mime"] as! String)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
        try execute("DELETE FROM media WHERE id=?", [id])
    }
}
