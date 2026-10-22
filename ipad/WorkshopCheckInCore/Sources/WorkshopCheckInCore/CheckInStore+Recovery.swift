import Foundation

extension CheckInStore {
    /// Builds a recovery file of the event's unsent operations with display
    /// names. Exporting changes no operation: it is not delivery. Call
    /// `confirmRecoverySaved` only once the file has actually been saved.
    public func exportRecovery(eventId: String, deviceId: String?) throws -> RecoveryExport {
        try locked {
            try db.transaction {
                guard let event = try loadEvent(eventId) else { throw CheckInError.unknownEvent }
                let pending = try db.query(
                    """
                    SELECT \(Self.operationColumns) FROM operations
                    WHERE event_id = ? AND state = 'pending' ORDER BY seq
                    """, [.text(eventId)], Self.readOperation)
                let exportId = UUID()
                let now = clock.wallNow()
                let file = RecoveryFile(
                    format: DeviceProtocol.recoveryFormat, version: DeviceProtocol.version,
                    eventId: eventId, eventCode: event.eventCode, deviceId: deviceId, exportedAt: now,
                    operations: pending.map {
                        RecoveryFile.Operation(opId: Self.wire($0.opId), personToken: $0.personToken,
                                               displayName: $0.displayName, baseRevision: $0.baseRevision,
                                               windowRevisionSeen: $0.windowRevisionSeen, recordedAt: $0.recordedAt)
                    })
                let data = try DeviceProtocol.encode(file)
                try db.execute(
                    "INSERT INTO recovery_exports (export_id, event_id, created_at) VALUES (?, ?, ?)",
                    [.text(Self.wire(exportId)), .text(eventId), .double(now.timeIntervalSince1970)])
                for operation in pending {
                    try db.execute("INSERT INTO recovery_export_ops (export_id, op_id) VALUES (?, ?)",
                                   [.text(Self.wire(exportId)), .text(Self.wire(operation.opId))])
                }
                let shortId = String(Self.wire(exportId).prefix(8))
                return RecoveryExport(exportId: exportId,
                                      fileName: "check-ins-\(event.eventCode)-\(shortId).attendance-recovery.json",
                                      data: data, operationCount: pending.count)
            }
        }
    }

    /// Marks an export as saved by the organiser. Operations stay pending:
    /// a saved file is a fallback, never proof of delivery or import.
    public func confirmRecoverySaved(_ exportId: UUID) throws {
        try locked {
            try db.execute("UPDATE recovery_exports SET saved_at = ? WHERE export_id = ? AND saved_at IS NULL",
                           [.double(clock.wallNow().timeIntervalSince1970), .text(Self.wire(exportId))])
            if db.changes == 0 {
                let known = try db.query("SELECT 1 FROM recovery_exports WHERE export_id = ?",
                                         [.text(Self.wire(exportId))]) { _ in true }
                if known.isEmpty { throw CheckInError.unknownRecoveryExport }
            }
        }
    }

    /// Exactly what removing the event's data would remove.
    public func removalPreview(eventId: String) throws -> RemovalPreview {
        try locked { try preview(eventId) }
    }

    /// Removes the event's names, operations, recovery records and pairing,
    /// and the names cached for every earlier event on this iPad.
    /// Refused while unsent operations lack a saved recovery file, or if
    /// anything changed since the organiser saw `preview`.
    public func removeEventData(confirming preview: RemovalPreview) throws {
        try locked {
            try db.transaction {
                let current = try self.preview(preview.eventId)
                guard current == preview else { throw CheckInError.removalPreviewOutdated }
                guard current.unsentOpIds.isEmpty || current.unsentCoveredBySavedRecovery else {
                    throw CheckInError.unsentNotRecovered(count: current.unsentOpIds.count)
                }
                let event = SQLValue.text(preview.eventId)
                try db.execute(
                    """
                    DELETE FROM recovery_export_ops WHERE export_id IN
                        (SELECT export_id FROM recovery_exports WHERE event_id = ?)
                    """, [event])
                try db.execute("DELETE FROM recovery_exports WHERE event_id = ?", [event])
                try db.execute("DELETE FROM operations WHERE event_id = ?", [event])
                try db.execute("DELETE FROM people WHERE event_id = ?", [event])
                try db.execute("DELETE FROM roster_versions WHERE event_id = ?", [event])
                try db.execute("DELETE FROM events WHERE event_id = ?", [event])
                try db.execute("DELETE FROM pairing WHERE event_id = ?", [event])
                try removeEarlierEvents()
            }
        }
    }

    /// Handing over leaves no names from any event. For other events the
    /// same safeguard holds: an unsent check-in without a saved recovery
    /// file stays, with its event and recovery records, so it can still be
    /// sent or exported. (Switching events is refused while such rows exist,
    /// so normally there are none.) Everything else goes.
    private func removeEarlierEvents() throws {
        let others = try db.query(
            """
            SELECT event_id FROM events UNION SELECT event_id FROM people
            UNION SELECT event_id FROM operations UNION SELECT event_id FROM roster_versions
            UNION SELECT event_id FROM recovery_exports
            """, []) { $0.text(0) }
        for other in others {
            let event = SQLValue.text(other)
            try db.execute("DELETE FROM people WHERE event_id = ?", [event])
            try db.execute("DELETE FROM roster_versions WHERE event_id = ?", [event])
            try db.execute(
                """
                DELETE FROM operations WHERE event_id = ? AND (state != 'pending' OR op_id IN (
                    SELECT x.op_id FROM recovery_export_ops x JOIN recovery_exports e ON e.export_id = x.export_id
                    WHERE e.saved_at IS NOT NULL))
                """, [event])
            let kept = try db.query("SELECT COUNT(*) FROM operations WHERE event_id = ?", [event]) {
                Int($0.int(0))
            }.first ?? 0
            guard kept == 0 else { continue }
            try db.execute(
                """
                DELETE FROM recovery_export_ops WHERE export_id IN
                    (SELECT export_id FROM recovery_exports WHERE event_id = ?)
                """, [event])
            try db.execute("DELETE FROM recovery_exports WHERE event_id = ?", [event])
            try db.execute("DELETE FROM events WHERE event_id = ?", [event])
        }
    }

    private func preview(_ eventId: String) throws -> RemovalPreview {
        let unsent = try db.query(
            "SELECT op_id, display_name FROM operations WHERE event_id = ? AND state = 'pending' ORDER BY seq",
            [.text(eventId)]) { (try Self.readOpId($0.text(0)), $0.text(1)) }
        let held = try db.query("SELECT COUNT(*) FROM operations WHERE event_id = ? AND state = 'held'",
                                [.text(eventId)]) { Int($0.int(0)) }.first ?? 0
        return RemovalPreview(eventId: eventId, unsentNames: unsent.map(\.1), unsentOpIds: unsent.map(\.0),
                              heldCount: held,
                              unsentCoveredBySavedRecovery: try uncoveredPendingCount(eventId: eventId) == 0)
    }
}
