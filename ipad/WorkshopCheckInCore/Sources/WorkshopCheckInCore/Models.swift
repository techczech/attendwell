import Foundation

/// What a name shows, in precedence order. Only `.checkedIn` may be described
/// as "checked in" (docs/adr/0004).
public enum RowStatus: String, Sendable, Equatable {
    case checkedIn
    case savedOnThisIPad
    case withTheOrganiser
    case notCheckedIn

    /// States 1–3 block a second check-in and sit in **Already done**.
    public var isDone: Bool { self != .notCheckedIn }
}

public struct PersonRow: Sendable, Equatable {
    public let personToken: String
    public let displayName: String
    public let status: RowStatus
    public init(personToken: String, displayName: String, status: RowStatus) {
        self.personToken = personToken; self.displayName = displayName; self.status = status
    }
}

public enum WindowState: String, Codable, Sendable {
    case open
    case closed
}

public struct WindowInfo: Codable, Sendable, Equatable {
    public var state: WindowState
    public var revision: Int
    public var openedAt: Date?
    public var closesAt: Date?

    public init(state: WindowState, revision: Int, openedAt: Date? = nil, closesAt: Date? = nil) {
        self.state = state
        self.revision = revision
        self.openedAt = openedAt
        self.closesAt = closesAt
    }
}

/// Outcome of a tap on a name. `.saved` is returned only after the local
/// commit succeeded; failures throw and never claim a save.
public enum RecordOutcome: Sendable, Hashable {
    case saved(opId: UUID)
    case alreadyDone(RowStatus, opId: UUID?)
}

public struct OutboxSummary: Sendable, Equatable {
    public let pending: Int
    public let held: Int
    public let acknowledged: Int

    public init(pending: Int, held: Int, acknowledged: Int) {
        self.pending = pending
        self.held = held
        self.acknowledged = acknowledged
    }
}

public enum CheckInError: Error, Equatable {
    case unknownEvent
    case unknownPerson
    case windowClosed
    case eventMismatch
    case differentEventHasUnsent(count: Int)
    case unsentNotRecovered(count: Int)
    case removalPreviewOutdated
    case unknownRecoveryExport
    case privacyViolation(String)
    case storage(String)
}

/// Why a delivery run stopped. Every stop keeps pending operations.
public enum DeliveryStop: Sendable, Equatable {
    case drained
    case windowClosed
    case alreadyDelivering
    case transport(TransportFailure)
    case invalidResponse
    case storageFailure
}

public struct DeliveryReport: Sendable, Equatable {
    public var acknowledged: [UUID] = []
    public var held: [UUID] = []
    public var stop: DeliveryStop = .drained

    public init(acknowledged: [UUID] = [], held: [UUID] = [], stop: DeliveryStop = .drained) {
        self.acknowledged = acknowledged
        self.held = held
        self.stop = stop
    }
}

/// Exactly what a removal would delete, shown to the organiser before
/// confirming. Removal is refused if the state changed since the preview.
public struct RemovalPreview: Sendable, Equatable {
    public let eventId: String
    public let unsentNames: [String]
    public let unsentOpIds: [UUID]
    public let heldCount: Int
    public let unsentCoveredBySavedRecovery: Bool
}

public struct RecoveryExport: Sendable {
    public let exportId: UUID
    public let fileName: String
    public let data: Data
    public let operationCount: Int
}
