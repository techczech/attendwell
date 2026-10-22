import Foundation
import SQLite3

/// Values bound to SQLite parameters. All SQL in this package uses binding;
/// no value is ever interpolated into statement text.
enum SQLValue {
    case text(String)
    case int(Int64)
    case double(Double)
    case null

    static func optional(_ value: Double?) -> SQLValue { value.map(SQLValue.double) ?? .null }
    static func optional(_ value: String?) -> SQLValue { value.map(SQLValue.text) ?? .null }
}

struct SQLiteError: Error, CustomStringConvertible {
    let code: Int32
    let message: String
    var description: String { "SQLite error \(code): \(message)" }
}

/// A row cursor valid only inside the `query` callback.
struct SQLRow {
    fileprivate let statement: OpaquePointer

    func text(_ column: Int32) -> String {
        guard let pointer = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: pointer)
    }

    func optionalText(_ column: Int32) -> String? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : text(column)
    }

    func int(_ column: Int32) -> Int64 { sqlite3_column_int64(statement, column) }
    func double(_ column: Int32) -> Double { sqlite3_column_double(statement, column) }

    func optionalDouble(_ column: Int32) -> Double? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : double(column)
    }
}

/// One serialised connection to a disk-backed SQLite file. Callers hold the
/// store lock; this type adds no locking of its own.
final class SQLiteDatabase {
    private var handle: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        var opened: OpaquePointer?
        let code = sqlite3_open_v2(path, &opened, flags, nil)
        handle = opened
        guard code == SQLITE_OK else {
            let error = SQLiteError(code: code, message: Self.message(opened))
            sqlite3_close_v2(opened)
            handle = nil
            throw error
        }
        sqlite3_busy_timeout(handle, 2_000)
        sqlite3_extended_result_codes(handle, 1)
    }

    deinit { sqlite3_close_v2(handle) }

    func execute(_ sql: String, _ parameters: [SQLValue] = []) throws {
        try withStatement(sql, parameters) { statement in
            let code = sqlite3_step(statement)
            guard code == SQLITE_DONE || code == SQLITE_ROW else { throw failure(code) }
        }
    }

    func query<T>(_ sql: String, _ parameters: [SQLValue] = [], _ read: (SQLRow) throws -> T) throws -> [T] {
        try withStatement(sql, parameters) { statement in
            var results: [T] = []
            while true {
                let code = sqlite3_step(statement)
                if code == SQLITE_DONE { return results }
                guard code == SQLITE_ROW else { throw failure(code) }
                results.append(try read(SQLRow(statement: statement)))
            }
        }
    }

    func scalarText(_ sql: String) throws -> String {
        try query(sql) { $0.text(0) }.first ?? ""
    }

    var changes: Int { Int(sqlite3_changes(handle)) }

    /// Runs `body` inside BEGIN IMMEDIATE … COMMIT. Any thrown error, including
    /// a failed COMMIT, rolls back and is rethrown; nothing partial survives.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let result = try body()
            try execute("COMMIT")
            return result
        } catch {
            if sqlite3_get_autocommit(handle) == 0 {
                try? execute("ROLLBACK")
            }
            throw error
        }
    }

    private func withStatement<T>(_ sql: String, _ parameters: [SQLValue], _ body: (OpaquePointer) throws -> T) throws -> T {
        var statement: OpaquePointer?
        let code = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard code == SQLITE_OK, let statement else { throw failure(code) }
        defer { sqlite3_finalize(statement) }
        for (offset, value) in parameters.enumerated() {
            let index = Int32(offset + 1)
            let bound: Int32
            switch value {
            case .text(let text): bound = sqlite3_bind_text(statement, index, text, -1, Self.transient)
            case .int(let number): bound = sqlite3_bind_int64(statement, index, number)
            case .double(let number): bound = sqlite3_bind_double(statement, index, number)
            case .null: bound = sqlite3_bind_null(statement, index)
            }
            guard bound == SQLITE_OK else { throw failure(bound) }
        }
        return try body(statement)
    }

    private func failure(_ code: Int32) -> SQLiteError {
        SQLiteError(code: code, message: Self.message(handle))
    }

    private static func message(_ handle: OpaquePointer?) -> String {
        guard let handle, let text = sqlite3_errmsg(handle) else { return "unknown" }
        return String(cString: text)
    }
}
