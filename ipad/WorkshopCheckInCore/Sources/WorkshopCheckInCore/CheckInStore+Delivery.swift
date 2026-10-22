import Foundation

extension CheckInStore {
    /// Sends pending operations for one event, oldest first, one at a time.
    ///
    /// - `applied` / `already_applied` acknowledge the operation (Checked in).
    /// - `held` is terminal: reported, never retried.
    /// - `closed`, a closed or expired window, any transport failure or an
    ///   unusable reply stop the run; the operation stays pending and the next
    ///   run resends the same `opId`.
    ///
    /// A second call for the same event while one runs returns `.alreadyDelivering`.
    public func deliverPending(eventId: String, via transport: DeviceTransport) async -> DeliveryReport {
        var report = DeliveryReport()
        guard beginDelivery(eventId) else {
            report.stop = .alreadyDelivering
            return report
        }
        defer { endDelivery(eventId) }

        while true {
            let next: OperationRecord?
            do {
                next = try locked {
                    guard let event = try loadEvent(eventId) else { return nil }
                    guard event.isOpen(clock) else { throw DeliveryHalt.windowClosed }
                    return try db.query(
                        """
                        SELECT \(Self.operationColumns) FROM operations
                        WHERE event_id = ? AND state = 'pending' ORDER BY seq LIMIT 1
                        """, [.text(eventId)], Self.readOperation).first
                }
            } catch DeliveryHalt.windowClosed {
                report.stop = .windowClosed
                return report
            } catch {
                report.stop = .storageFailure
                return report
            }
            guard let operation = next else {
                report.stop = .drained
                return report
            }

            let reply: Data
            do {
                let body = try DeviceProtocol.encode(OperationsRequest(eventId: eventId, operations: [operation.wire]))
                reply = try await transport.submitOperations(eventId: eventId, body: body)
            } catch let failure as TransportFailure {
                report.stop = .transport(failure)
                return report
            } catch {
                report.stop = .transport(.unreachable)
                return report
            }

            guard let response = try? DeviceProtocol.decode(OperationsResponse.self, from: reply),
                  response.eventId == eventId,
                  let result = response.results.first(where: { $0.opId == Self.wire(operation.opId) })
            else {
                report.stop = .invalidResponse
                return report
            }

            do {
                try locked {
                    try db.transaction {
                        guard let event = try loadEvent(eventId) else { return }
                        try observe(eventId: eventId, eventCode: event.eventCode,
                                    window: response.window, serverTime: response.serverTime)
                        try settle(operation.opId, outcome: result.outcome, reason: result.reason)
                    }
                }
            } catch {
                report.stop = .storageFailure
                return report
            }

            switch result.outcome {
            case .applied, .alreadyApplied:
                report.acknowledged.append(operation.opId)
            case .held:
                report.held.append(operation.opId)
            case .closed:
                report.stop = .windowClosed
                return report
            }
        }
    }

    /// Deletes acknowledged operations settled at least 7 days ago whose person
    /// the roster confirms as checked in. Pending and held rows are never pruned.
    @discardableResult
    public func pruneAcknowledged() throws -> Int {
        try locked {
            try db.transaction {
                let cutoff = clock.wallNow().timeIntervalSince1970 - Self.acknowledgedRetention
                try db.execute(
                    """
                    DELETE FROM operations
                    WHERE state = 'acknowledged' AND settled_at IS NOT NULL AND settled_at <= ?
                      AND EXISTS (SELECT 1 FROM people p WHERE p.event_id = operations.event_id
                                  AND p.person_token = operations.person_token AND p.server_checked_in = 1)
                    """, [.double(cutoff)])
                let pruned = db.changes
                try db.execute("DELETE FROM recovery_export_ops WHERE op_id NOT IN (SELECT op_id FROM operations)")
                return pruned
            }
        }
    }

    private enum DeliveryHalt: Error { case windowClosed }

    /// Only a pending operation can settle, so a late duplicate reply never
    /// changes a held or acknowledged row.
    private func settle(_ opId: UUID, outcome: OperationOutcome, reason: String?) throws {
        let now = SQLValue.double(clock.wallNow().timeIntervalSince1970)
        switch outcome {
        case .applied, .alreadyApplied:
            try db.execute(
                "UPDATE operations SET state = 'acknowledged', settled_at = ? WHERE op_id = ? AND state = 'pending'",
                [now, .text(Self.wire(opId))])
        case .held:
            try db.execute(
                """
                UPDATE operations SET state = 'held', held_reason = ?, settled_at = ?
                WHERE op_id = ? AND state = 'pending'
                """, [.optional(reason), now, .text(Self.wire(opId))])
        case .closed:
            break
        }
    }
}
