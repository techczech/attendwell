import Foundation

// PROVISIONAL device protocol v1 shapes. These mirror the fixtures in
// `contract/device-v1/` and are not validated against the host yet.

public struct RosterPerson: Codable, Sendable, Equatable {
    public var personToken: String
    public var displayName: String
    public var revision: Int
    public var checkedIn: Bool

    public init(personToken: String, displayName: String, revision: Int, checkedIn: Bool) {
        self.personToken = personToken
        self.displayName = displayName
        self.revision = revision
        self.checkedIn = checkedIn
    }
}

/// A roster response: names-only people plus the window and server time.
public struct RosterSnapshot: Codable, Sendable, Equatable {
    public var eventId: String
    public var eventCode: String
    public var serverTime: Date
    public var window: WindowInfo
    public var people: [RosterPerson]
    /// Opaque `rv_…` key that changes whenever anything but `serverTime`
    /// changes. Not ordered: compare for equality only. Stored with the names
    /// in one transaction, so it always describes the cached list.
    public var rosterVersion: String?

    public init(eventId: String, eventCode: String, serverTime: Date, window: WindowInfo, people: [RosterPerson],
                rosterVersion: String? = nil) {
        self.eventId = eventId
        self.eventCode = eventCode
        self.serverTime = serverTime
        self.window = window
        self.people = people
        self.rosterVersion = rosterVersion
    }

    /// 1–128 characters of A–Z a–z 0–9 . _ ~ - (the host sends `rv_` + hex).
    public static func isValidRosterVersion(_ value: String) -> Bool {
        (1...128).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
                || $0 == 46 || $0 == 95 || $0 == 126 || $0 == 45
        }
    }
}

/// What the iPad tells the laptop about its own outbox in a heartbeat. The
/// organiser sees these counts on the device row. Counts only, never names.
public struct HeartbeatReport: Codable, Sendable, Equatable {
    public var pendingCount: Int
    public var heldCount: Int
    public var oldestPendingAt: Date?
    public var appVersion: String?
    public init(pendingCount: Int, heldCount: Int, oldestPendingAt: Date?, appVersion: String?) {
        self.pendingCount = pendingCount; self.heldCount = heldCount
        self.oldestPendingAt = oldestPendingAt; self.appVersion = appVersion
    }
}

/// Heartbeat reply: the window, server time and current roster version.
public struct HeartbeatReply: Codable, Sendable, Equatable {
    public var eventId: String
    public var serverTime: Date
    public var window: WindowInfo
    public var rosterVersion: String
    public init(eventId: String, serverTime: Date, window: WindowInfo, rosterVersion: String) {
        self.eventId = eventId; self.serverTime = serverTime; self.window = window; self.rosterVersion = rosterVersion
    }
}


public struct WireOperation: Codable, Sendable, Equatable {
    public var opId: String
    public var personToken: String
    public var baseRevision: Int
    public var windowRevisionSeen: Int
    public var recordedAt: Date
}

public struct OperationsRequest: Codable, Sendable, Equatable {
    public var eventId: String
    public var operations: [WireOperation]
}

public enum OperationOutcome: String, Codable, Sendable {
    case applied
    case alreadyApplied = "already_applied"
    case held
    case closed
}

public struct OperationResult: Codable, Sendable, Equatable {
    public var opId: String
    public var outcome: OperationOutcome
    public var reason: String?

    public init(opId: String, outcome: OperationOutcome, reason: String? = nil) {
        self.opId = opId
        self.outcome = outcome
        self.reason = reason
    }
}

public struct OperationsResponse: Codable, Sendable, Equatable {
    public var eventId: String
    public var serverTime: Date
    public var window: WindowInfo
    public var results: [OperationResult]

    public init(eventId: String, serverTime: Date, window: WindowInfo, results: [OperationResult]) {
        self.eventId = eventId
        self.serverTime = serverTime
        self.window = window
        self.results = results
    }
}

/// `.attendance-recovery.json`: names and operations only, never email.
public struct RecoveryFile: Codable, Sendable, Equatable {
    public struct Operation: Codable, Sendable, Equatable {
        public var opId: String
        public var personToken: String
        public var displayName: String
        public var baseRevision: Int
        public var windowRevisionSeen: Int
        public var recordedAt: Date
    }

    public var format: String
    public var version: Int
    public var eventId: String
    public var eventCode: String
    public var deviceId: String?
    public var exportedAt: Date
    public var operations: [Operation]
}

/// Sends one encoded operations request and returns the encoded response.
/// Throw `TransportFailure` for anything without a definite answer; the
/// operation then stays pending and is resent with the same `opId`.
public protocol DeviceTransport: Sendable {
    func submitOperations(eventId: String, body: Data) async throws -> Data
}

public enum TransportFailure: Error, Sendable, Equatable {
    case unreachable
    case timedOut
    case revoked
    case updateNeeded
    case eventMoved
    /// 429 `rate_limited` (with Retry-After): the laptop asked this iPad to
    /// slow down. `LiveHostTransport` refuses every request to that laptop on
    /// the iPad until the Retry-After deadline has passed.
    case rateLimited
}

/// The schema boundary. Every payload in or out passes a names-only privacy
/// check before (de)coding.
public enum DeviceProtocol {
    public static let version = 1
    public static let recoveryFormat = "attendance-recovery"

    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        try requireNamesOnly(data)
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = (try? millisecondDates.parse(text)) ?? (try? wholeSecondDates.parse(text)) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "expected an ISO 8601 date")
        }
        return try decoder.decode(T.self, from: data)
    }

    public static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(wireDate(date))
        }
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        let data = try encoder.encode(value)
        try requireNamesOnly(data)
        return data
    }

    /// The same check for typed values that reach storage without passing
    /// through `decode`. Throws before the caller changes anything.
    static func requireNamesOnly<T: Encodable>(_ value: T) throws {
        _ = try encode(value)
    }

    /// Error text names only JSON paths, never the offending value.
    private static func requireNamesOnly(_ data: Data) throws {
        let violations = privacyViolations(in: data)
        guard violations.isEmpty else { throw CheckInError.privacyViolation(violations.joined(separator: ", ")) }
    }

    // Value types, so sharing them across threads is safe. Dates are written
    // with milliseconds; whole-second dates are still read.
    private static let millisecondDates = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let wholeSecondDates = Date.ISO8601FormatStyle()

    /// `2026-10-14T09:02:10.007Z`. Rounds to the nearest millisecond; the
    /// system formatter truncates, which turns `.007` into `.006`.
    private static func wireDate(_ date: Date) -> String {
        let millis = (date.timeIntervalSince1970 * 1000).rounded()
        let seconds = (millis / 1000).rounded(.down)
        let whole = wholeSecondDates.format(Date(timeIntervalSince1970: seconds))
        return whole.dropLast() + String(format: ".%03dZ", Int(millis - seconds * 1000))
    }

    /// Lists forbidden keys (email, booking, source) and email-like strings
    /// anywhere in a JSON payload. Unparseable JSON is itself a violation.
    public static func privacyViolations(in data: Data) -> [String] {
        guard let root = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return ["not JSON"]
        }
        var found: [String] = []
        walk(root, path: "$", into: &found)
        return found
    }

    private static func walk(_ value: Any, path: String, into found: inout [String]) {
        if let object = value as? [String: Any] {
            for (key, child) in object {
                if isForbiddenKey(key) { found.append("\(path).\(key): forbidden key") }
                walk(child, path: "\(path).\(key)", into: &found)
            }
        } else if let array = value as? [Any] {
            for (index, child) in array.enumerated() { walk(child, path: "\(path)[\(index)]", into: &found) }
        } else if let text = value as? String, looksLikeEmail(text) {
            found.append("\(path): email-like value")
        }
    }

    private static func isForbiddenKey(_ key: String) -> Bool {
        let normalised = key.lowercased().filter { $0.isLetter || $0.isNumber }
        return normalised.contains("email") || normalised.contains("booking")
            || normalised == "source" || normalised.hasSuffix("source")
    }

    private static let emailPattern = try! NSRegularExpression(pattern: "[^\\s@]+@[^\\s@]+\\.[^\\s@]+")

    private static func looksLikeEmail(_ text: String) -> Bool {
        emailPattern.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}
