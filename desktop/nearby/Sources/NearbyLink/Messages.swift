import Foundation

public struct NameEntry: Codable, Equatable {
    public var id: String
    public var displayName: String
    public var hidden: Bool
    public init(id: String, displayName: String, hidden: Bool) { self.id = id; self.displayName = displayName; self.hidden = hidden }
}

public struct Hello: Codable, Equatable {
    public var v: Int
    public var role: String
    public var device: String
    public var lastSnapshotVersion: Int
    public var unacked: Int
    public init(role: String, device: String, lastSnapshotVersion: Int, unacked: Int) {
        v = 1; self.role = role; self.device = device; self.lastSnapshotVersion = lastSnapshotVersion; self.unacked = unacked
    }
}

/// No email addresses, ever: names carry an id, a display name and whether they are hidden.
public struct Snapshot: Codable, Equatable {
    public var version: Int
    public var workshopId: String
    public var title: String
    public var open: Bool
    public var names: [NameEntry]
    public init(version: Int, workshopId: String, title: String, open: Bool, names: [NameEntry]) {
        self.version = version; self.workshopId = workshopId; self.title = title; self.open = open; self.names = names
    }
}

public struct CheckIn: Codable, Equatable {
    public var opId: String
    public var nameId: String
    public var at: String
    public init(opId: String = UUID().uuidString, nameId: String, at: String) { self.opId = opId; self.nameId = nameId; self.at = at }
    public static func isoNow() -> String { ISO8601DateFormatter.withFraction.string(from: Date()) }
}

extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
}

/// The four application messages. On the wire: JSON with a "type" field, then sealed (see SharedKey).
public enum Message: Equatable {
    case hello(Hello)
    case snapshot(Snapshot)
    case checkin(CheckIn)
    case ack([String])
}

extension Message: Codable {
    private enum K: String, CodingKey { case type }
    private struct AckBody: Codable { var opIds: [String] }

    public init(from decoder: Decoder) throws {
        let type = try decoder.container(keyedBy: K.self).decode(String.self, forKey: .type)
        switch type {
        case "hello": self = .hello(try Hello(from: decoder))
        case "snapshot": self = .snapshot(try Snapshot(from: decoder))
        case "checkin": self = .checkin(try CheckIn(from: decoder))
        case "ack": self = .ack(try AckBody(from: decoder).opIds)
        default: throw DecodingError.dataCorruptedError(forKey: .type, in: try decoder.container(keyedBy: K.self), debugDescription: "unknown type \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .hello(let h): try c.encode("hello", forKey: .type); try h.encode(to: encoder)
        case .snapshot(let s): try c.encode("snapshot", forKey: .type); try s.encode(to: encoder)
        case .checkin(let x): try c.encode("checkin", forKey: .type); try x.encode(to: encoder)
        case .ack(let ids): try c.encode("ack", forKey: .type); try AckBody(opIds: ids).encode(to: encoder)
        }
    }

    public func sealed(with key: SharedKey) throws -> Data { try key.seal(JSONEncoder().encode(self)) }
    public static func open(_ data: Data, with key: SharedKey) throws -> Message { try JSONDecoder().decode(Message.self, from: key.open(data)) }
}

/// Monotonic milliseconds (system uptime clock, shared by every process on this Mac), for measurement.
public func monotonicMs() -> Int { Int(DispatchTime.now().uptimeNanoseconds / 1_000_000) }
