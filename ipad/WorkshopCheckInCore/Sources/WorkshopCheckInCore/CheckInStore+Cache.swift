import Foundation

/// The session cache: the names list, workshop window and roster version the
/// iPad keeps so check-ins never depend on a live connection.
extension CheckInStore {
    /// Roster version stored with the last applied names list, if any.
    public func rosterVersion(eventId: String) throws -> String? {
        try locked {
            try db.query("SELECT roster_version FROM roster_versions WHERE event_id = ?",
                         [.text(eventId)]) { $0.text(0) }.first
        }
    }

    /// The cached names list with the roster version it was stored under, or
    /// nil if this event has never had a names list on this iPad. Read in one
    /// lock so the people and version always belong together.
    public func cachedRoster(eventId: String) throws -> (people: [RosterPerson], rosterVersion: String?)? {
        try locked {
            guard try loadEvent(eventId) != nil else { return nil }
            let people = try db.query(
                """
                SELECT person_token, display_name, revision, server_checked_in FROM people
                WHERE event_id = ? ORDER BY person_token
                """, [.text(eventId)]) {
                RosterPerson(personToken: $0.text(0), displayName: $0.text(1), revision: Int($0.int(2)),
                             checkedIn: $0.int(3) != 0)
            }
            let version = try db.query("SELECT roster_version FROM roster_versions WHERE event_id = ?",
                                       [.text(eventId)]) { $0.text(0) }.first
            return (people, version)
        }
    }

    /// Outbox counts for the heartbeat: numbers only, never names.
    public func heartbeatReport(eventId: String, appVersion: String?) throws -> HeartbeatReport {
        let summary = try outboxSummary(eventId: eventId)
        return HeartbeatReport(pendingCount: summary.pending, heldCount: summary.held,
                               oldestPendingAt: try oldestPendingDate(eventId: eventId), appVersion: appVersion)
    }
}
