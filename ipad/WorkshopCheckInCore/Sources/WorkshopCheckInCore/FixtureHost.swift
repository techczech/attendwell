import Foundation

/// FICTIONAL first-stage transport: an in-memory stand-in for the laptop host
/// that follows the PROVISIONAL protocol fixtures. It is not an HTTP client,
/// talks to no service and is not evidence of real host behaviour.
///
/// Modelled rules: idempotency keyed by `(eventId, opId)`; a closed or expired
/// window answers `closed` without recording; a `baseRevision` that differs
/// from the person's current revision is `held` (stale); window revisions are
/// audit only.
public actor FixtureHost: DeviceTransport {
    public nonisolated let eventId: String
    public nonisolated let eventCode: String
    private var window: WindowInfo
    private var people: [RosterPerson]
    private var outcomes: [String: OperationOutcome] = [:]
    private let now: @Sendable () -> Date
    public private(set) var receivedOpIds: [String] = []
    public private(set) var receivedRequests: [OperationsRequest] = []

    public init(eventId: String, eventCode: String, people: [RosterPerson], window: WindowInfo,
                now: @escaping @Sendable () -> Date) {
        self.eventId = eventId
        self.eventCode = eventCode
        self.people = people
        self.window = window
        self.now = now
    }

    public func roster() -> RosterSnapshot {
        RosterSnapshot(eventId: eventId, eventCode: eventCode, serverTime: now(), window: window, people: people)
    }

    public func currentWindow() -> WindowInfo { window }

    /// Number of distinct operations that changed attendance.
    public func appliedCount() -> Int { outcomes.values.filter { $0 == .applied }.count }

    public func close() {
        window = WindowInfo(state: .closed, revision: window.revision + 1, openedAt: window.openedAt,
                            closesAt: window.closesAt)
    }

    public func reopen(closesAt: Date?) {
        window = WindowInfo(state: .open, revision: window.revision + 1, openedAt: now(), closesAt: closesAt)
    }

    /// Organiser undo: clears attendance and bumps the person's revision.
    public func undoCheckIn(personToken: String) {
        guard let index = people.firstIndex(where: { $0.personToken == personToken }) else { return }
        people[index].checkedIn = false
        people[index].revision += 1
    }

    public func submitOperations(eventId requestEvent: String, body: Data) async throws -> Data {
        let request = try DeviceProtocol.decode(OperationsRequest.self, from: body)
        receivedRequests.append(request)
        guard requestEvent == eventId, request.eventId == eventId else { throw TransportFailure.revoked }
        let results = request.operations.map { operation -> OperationResult in
            receivedOpIds.append(operation.opId)
            let outcome = outcome(for: operation)
            return OperationResult(opId: operation.opId, outcome: outcome,
                                   reason: outcome == .held ? "stale" : nil)
        }
        return try DeviceProtocol.encode(
            OperationsResponse(eventId: eventId, serverTime: now(), window: window, results: results))
    }

    private func outcome(for operation: WireOperation) -> OperationOutcome {
        if let previous = outcomes[operation.opId] {
            return previous == .applied ? .alreadyApplied : previous
        }
        let expired = window.closesAt.map { now() >= $0 } ?? false
        if window.state == .closed || expired { return .closed }
        guard let index = people.firstIndex(where: { $0.personToken == operation.personToken }),
              people[index].revision == operation.baseRevision
        else {
            outcomes[operation.opId] = .held
            return .held
        }
        people[index].checkedIn = true
        people[index].revision += 1
        outcomes[operation.opId] = .applied
        return .applied
    }
}
