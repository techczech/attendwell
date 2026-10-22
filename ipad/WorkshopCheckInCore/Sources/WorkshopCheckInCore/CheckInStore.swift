import Foundation

/// The iPad's durable, event-scoped names list and outbox.
///
/// Every mutating call commits to a disk-backed SQLite file
/// (`synchronous=FULL`) before it returns. No method waits on the network
/// while holding the store; delivery runs outside the lock.
public final class CheckInStore: @unchecked Sendable {
    public struct Pairing: Sendable, Equatable {
        public let eventId: String
        public let participantAddress: String
    }

    public struct StorageSettings: Sendable, Equatable {
        public let journalMode: String
        public let synchronous: String

        public init(journalMode: String, synchronous: String) {
            self.journalMode = journalMode
            self.synchronous = synchronous
        }
    }

    static let acknowledgedRetention: TimeInterval = 7 * 24 * 60 * 60

    let db: SQLiteDatabase
    let clock: CheckInClock
    private let lock = NSLock()
    private var delivering: Set<String> = []

    /// Opens or creates the store at `fileURL` (Application Support on the
    /// iPad). The file is excluded from device backup as a privacy default.
    public init(fileURL: URL, clock: CheckInClock = SystemClock()) throws {
        self.clock = clock
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            db = try SQLiteDatabase(path: fileURL.path)
            _ = try db.query("PRAGMA journal_mode=DELETE") { $0.text(0) }
            try db.execute("PRAGMA synchronous=FULL")
            try db.transaction { for statement in Self.schema { try db.execute(statement) } }
        } catch let error as SQLiteError {
            throw CheckInError.storage(error.description)
        }
        try Self.applyFileProtection(fileURL)
    }

    // MARK: Record and read

    /// Records a check-in for one person in one event. Returns `.saved` only
    /// after the local commit; a tap on a done name returns `.alreadyDone`
    /// with the existing operation. Concurrent and repeated taps share one `opId`.
    public func recordCheckIn(eventId: String, personToken: String) throws -> RecordOutcome {
        try locked {
            try db.transaction {
                guard let event = try loadEvent(eventId) else { throw CheckInError.unknownEvent }
                let person = try db.query(
                    "SELECT display_name, revision, server_checked_in FROM people WHERE event_id = ? AND person_token = ?",
                    [.text(eventId), .text(personToken)]
                ) { (name: $0.text(0), revision: $0.int(1), checkedIn: $0.int(2) != 0) }.first
                if let existing = try operation(eventId: eventId, personToken: personToken) {
                    let status = Self.status(opState: existing.state, serverCheckedIn: person?.checkedIn ?? false)
                    return .alreadyDone(status, opId: existing.opId)
                }
                guard let person else { throw CheckInError.unknownPerson }
                if person.checkedIn { return .alreadyDone(.checkedIn, opId: nil) }
                guard event.isOpen(clock) else { throw CheckInError.windowClosed }
                let opId = UUID()
                try db.execute(
                    """
                    INSERT INTO operations (op_id, event_id, person_token, display_name, base_revision,
                        window_revision_seen, recorded_at, state)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
                    """,
                    [.text(Self.wire(opId)), .text(eventId), .text(personToken), .text(person.name),
                     .int(person.revision), .int(Int64(event.window.revision)),
                     .double(clock.wallNow().timeIntervalSince1970)])
                return .saved(opId: opId)
            }
        }
    }

    /// Names for one event with their row status, alphabetical.
    public func rows(eventId: String) throws -> [PersonRow] {
        try locked {
            try db.query(
                """
                SELECT p.person_token, p.display_name, p.server_checked_in, o.state
                FROM people p LEFT JOIN operations o
                  ON o.event_id = p.event_id AND o.person_token = p.person_token
                WHERE p.event_id = ? ORDER BY p.display_name COLLATE NOCASE, p.person_token
                """, [.text(eventId)]
            ) {
                PersonRow(personToken: $0.text(0), displayName: $0.text(1),
                          status: Self.status(opState: $0.optionalText(3), serverCheckedIn: $0.int(2) != 0))
            }
        }
    }

    public func status(eventId: String, personToken: String) throws -> RowStatus {
        try locked {
            let serverCheckedIn = try db.query(
                "SELECT server_checked_in FROM people WHERE event_id = ? AND person_token = ?",
                [.text(eventId), .text(personToken)]) { $0.int(0) != 0 }.first ?? false
            let state = try operation(eventId: eventId, personToken: personToken)?.state
            return Self.status(opState: state, serverCheckedIn: serverCheckedIn)
        }
    }

    public func outboxSummary(eventId: String) throws -> OutboxSummary {
        try locked {
            let counts = try db.query(
                "SELECT state, COUNT(*) FROM operations WHERE event_id = ? GROUP BY state",
                [.text(eventId)]) { ($0.text(0), Int($0.int(1))) }
            let byState = Dictionary(uniqueKeysWithValues: counts)
            return OutboxSummary(pending: byState["pending"] ?? 0, held: byState["held"] ?? 0,
                                 acknowledged: byState["acknowledged"] ?? 0)
        }
    }

    /// The operation id recorded for a person, if any.
    public func opId(eventId: String, personToken: String) throws -> UUID? {
        try locked { try operation(eventId: eventId, personToken: personToken)?.opId }
    }

    // MARK: Roster and window

    /// Applies a roster response for its event. Older snapshots than the last
    /// applied one are ignored (returns false). Operations are never touched.
    /// A snapshot that fails the names-only check is refused before any change.
    @discardableResult
    public func applyRoster(_ snapshot: RosterSnapshot) throws -> Bool {
        try DeviceProtocol.requireNamesOnly(snapshot)
        return try locked {
            try db.transaction {
                let rosterTime = try db.query(
                    "SELECT roster_server_time FROM events WHERE event_id = ?",
                    [.text(snapshot.eventId)]) { $0.double(0) }.first
                if let rosterTime, snapshot.serverTime.timeIntervalSince1970 < rosterTime { return false }
                try observe(eventId: snapshot.eventId, eventCode: snapshot.eventCode,
                            window: snapshot.window, serverTime: snapshot.serverTime)
                try db.execute("UPDATE events SET roster_server_time = ? WHERE event_id = ?",
                               [.double(snapshot.serverTime.timeIntervalSince1970), .text(snapshot.eventId)])
                try db.execute("DELETE FROM people WHERE event_id = ?", [.text(snapshot.eventId)])
                for person in snapshot.people {
                    try db.execute(
                        """
                        INSERT INTO people (event_id, person_token, display_name, revision, server_checked_in)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        [.text(snapshot.eventId), .text(person.personToken), .text(person.displayName),
                         .int(Int64(person.revision)), .int(person.checkedIn ? 1 : 0)])
                }
                // The version names exactly these people: same transaction, so
                // a failed apply can never leave a version ahead of the names.
                try db.execute("DELETE FROM roster_versions WHERE event_id = ?", [.text(snapshot.eventId)])
                if let version = snapshot.rosterVersion, RosterSnapshot.isValidRosterVersion(version) {
                    try db.execute("INSERT INTO roster_versions (event_id, roster_version) VALUES (?, ?)",
                                   [.text(snapshot.eventId), .text(version)])
                }
                return true
            }
        }
    }

    /// Applies a heartbeat's window and server time for a known event.
    public func applyWindow(eventId: String, window: WindowInfo, serverTime: Date) throws {
        try locked {
            try db.transaction {
                guard let event = try loadEvent(eventId) else { throw CheckInError.unknownEvent }
                try observe(eventId: eventId, eventCode: event.eventCode, window: window, serverTime: serverTime)
            }
        }
    }

    /// Effective window: closed if the host says so or estimated server time ≥ `closesAt`.
    public func isWindowOpen(eventId: String) throws -> Bool {
        try locked {
            guard let event = try loadEvent(eventId) else { throw CheckInError.unknownEvent }
            return event.isOpen(clock)
        }
    }

    public func estimatedServerTime(eventId: String) throws -> Date {
        try locked {
            guard let event = try loadEvent(eventId) else { throw CheckInError.unknownEvent }
            return event.anchor.estimatedServerTime(clock)
        }
    }

    // MARK: Pairing metadata

    public func pairing() throws -> Pairing? {
        try locked {
            try db.query("SELECT event_id, participant_address FROM pairing WHERE singleton = 1") {
                Pairing(eventId: $0.text(0), participantAddress: $0.text(1))
            }.first
        }
    }

    /// Records the paired event and participant address. The address is
    /// metadata only; changing it never touches the outbox. Switching to a
    /// different event is refused while the current one has unsent
    /// operations not covered by a saved recovery file. No rows are deleted.
    public func setPairing(eventId: String, participantAddress: String) throws {
        try DeviceProtocol.requireNamesOnly([eventId, participantAddress])
        try locked {
            try db.transaction {
                let current = try db.query("SELECT event_id FROM pairing WHERE singleton = 1") { $0.text(0) }.first
                if let current, current != eventId {
                    let unsent = try uncoveredPendingCount(eventId: current)
                    if unsent > 0 { throw CheckInError.differentEventHasUnsent(count: unsent) }
                }
                try db.execute(
                    """
                    INSERT INTO pairing (singleton, event_id, participant_address) VALUES (1, ?, ?)
                    ON CONFLICT(singleton) DO UPDATE SET event_id = excluded.event_id,
                        participant_address = excluded.participant_address
                    """, [.text(eventId), .text(participantAddress)])
            }
        }
    }

    public func storageSettings() throws -> StorageSettings {
        try locked {
            StorageSettings(journalMode: try db.scalarText("PRAGMA journal_mode"),
                            synchronous: try db.scalarText("PRAGMA synchronous"))
        }
    }

    // MARK: Internals shared with extensions

    struct EventRecord {
        let eventId: String
        let eventCode: String
        let window: WindowInfo
        let anchor: ClockAnchor

        func isOpen(_ clock: CheckInClock) -> Bool {
            guard window.state == .open else { return false }
            guard let closesAt = window.closesAt else { return true }
            return anchor.estimatedServerTime(clock) < closesAt
        }
    }

    struct OperationRecord {
        let opId: UUID
        let personToken: String
        let displayName: String
        let baseRevision: Int
        let windowRevisionSeen: Int
        let recordedAt: Date
        let state: String

        var wire: WireOperation {
            WireOperation(opId: CheckInStore.wire(opId), personToken: personToken, baseRevision: baseRevision,
                          windowRevisionSeen: windowRevisionSeen, recordedAt: recordedAt)
        }
    }

    static let operationColumns =
        "op_id, person_token, display_name, base_revision, window_revision_seen, recorded_at, state"

    static func readOperation(_ row: SQLRow) throws -> OperationRecord {
        OperationRecord(opId: try readOpId(row.text(0)), personToken: row.text(1),
                        displayName: row.text(2), baseRevision: Int(row.int(3)),
                        windowRevisionSeen: Int(row.int(4)),
                        recordedAt: Date(timeIntervalSince1970: row.double(5)), state: row.text(6))
    }

    static func wire(_ opId: UUID) -> String { opId.uuidString.lowercased() }

    static func readOpId(_ text: String) throws -> UUID {
        guard let opId = UUID(uuidString: text) else { throw CheckInError.storage("unreadable opId") }
        return opId
    }

    static func status(opState: String?, serverCheckedIn: Bool) -> RowStatus {
        if serverCheckedIn || opState == "acknowledged" { return .checkedIn }
        switch opState {
        case "pending": return .savedOnThisIPad
        case "held": return .withTheOrganiser
        default: return .notCheckedIn
        }
    }

    /// Serialises all database access. Never held across an `await`.
    func locked<T>(_ body: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        do {
            return try body()
        } catch let error as SQLiteError {
            throw CheckInError.storage(error.description)
        }
    }

    func beginDelivery(_ eventId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return delivering.insert(eventId).inserted
    }

    func endDelivery(_ eventId: String) {
        lock.lock()
        defer { lock.unlock() }
        delivering.remove(eventId)
    }

    func loadEvent(_ eventId: String) throws -> EventRecord? {
        try db.query(
            """
            SELECT event_code, window_state, window_revision, opened_at, closes_at,
                   server_time, sync_wall, sync_monotonic, sync_boot
            FROM events WHERE event_id = ?
            """, [.text(eventId)]
        ) { row in
            EventRecord(
                eventId: eventId, eventCode: row.text(0),
                window: WindowInfo(state: WindowState(rawValue: row.text(1)) ?? .closed,
                                   revision: Int(row.int(2)),
                                   openedAt: row.optionalDouble(3).map(Date.init(timeIntervalSince1970:)),
                                   closesAt: row.optionalDouble(4).map(Date.init(timeIntervalSince1970:))),
                anchor: ClockAnchor(serverTime: Date(timeIntervalSince1970: row.double(5)),
                                    wallAtSync: Date(timeIntervalSince1970: row.double(6)),
                                    monotonicAtSync: row.double(7), bootAtSync: row.text(8)))
        }.first
    }

    func operation(eventId: String, personToken: String) throws -> OperationRecord? {
        try db.query(
            "SELECT \(Self.operationColumns) FROM operations WHERE event_id = ? AND person_token = ?",
            [.text(eventId), .text(personToken)], Self.readOperation).first
    }

    /// Records a server observation: window plus clock anchor. Observations
    /// older than the stored one are ignored so a late reply cannot reopen.
    /// A window revision lower than the stored one is stale even at the same
    /// or a later server time: only its clock anchor is kept.
    func observe(eventId: String, eventCode: String, window: WindowInfo, serverTime: Date) throws {
        let stored = try db.query("SELECT server_time, window_revision FROM events WHERE event_id = ?",
                                  [.text(eventId)]) { (time: $0.double(0), revision: Int($0.int(1))) }.first
        if let stored, serverTime.timeIntervalSince1970 < stored.time { return }
        if let stored, window.revision < stored.revision {
            try db.execute(
                """
                UPDATE events SET server_time = ?, sync_wall = ?, sync_monotonic = ?, sync_boot = ?
                WHERE event_id = ?
                """,
                [.double(serverTime.timeIntervalSince1970), .double(clock.wallNow().timeIntervalSince1970),
                 .double(clock.monotonicSeconds()), .text(clock.bootID()), .text(eventId)])
            return
        }
        let values: [SQLValue] = [
            .text(eventId), .text(eventCode), .text(window.state.rawValue), .int(Int64(window.revision)),
            .optional(window.openedAt?.timeIntervalSince1970), .optional(window.closesAt?.timeIntervalSince1970),
            .double(serverTime.timeIntervalSince1970), .double(clock.wallNow().timeIntervalSince1970),
            .double(clock.monotonicSeconds()), .text(clock.bootID()),
        ]
        try db.execute(
            """
            INSERT INTO events (event_id, event_code, window_state, window_revision, opened_at, closes_at,
                server_time, sync_wall, sync_monotonic, sync_boot, roster_server_time)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(event_id) DO UPDATE SET event_code = excluded.event_code,
                window_state = excluded.window_state, window_revision = excluded.window_revision,
                opened_at = excluded.opened_at, closes_at = excluded.closes_at,
                server_time = excluded.server_time, sync_wall = excluded.sync_wall,
                sync_monotonic = excluded.sync_monotonic, sync_boot = excluded.sync_boot
            """, values)
    }

    func uncoveredPendingCount(eventId: String) throws -> Int {
        try db.query(
            """
            SELECT COUNT(*) FROM operations o
            WHERE o.event_id = ? AND o.state = 'pending' AND NOT EXISTS (
                SELECT 1 FROM recovery_export_ops x JOIN recovery_exports e ON e.export_id = x.export_id
                WHERE x.op_id = o.op_id AND e.saved_at IS NOT NULL)
            """, [.text(eventId)]) { Int($0.int(0)) }.first ?? 0
    }

    private static let schema = [
        """
        CREATE TABLE IF NOT EXISTS events (
            event_id TEXT PRIMARY KEY, event_code TEXT NOT NULL,
            window_state TEXT NOT NULL CHECK (window_state IN ('open', 'closed')),
            window_revision INTEGER NOT NULL, opened_at REAL, closes_at REAL,
            server_time REAL NOT NULL, sync_wall REAL NOT NULL, sync_monotonic REAL NOT NULL,
            sync_boot TEXT NOT NULL, roster_server_time REAL NOT NULL)
        """,
        """
        CREATE TABLE IF NOT EXISTS people (
            event_id TEXT NOT NULL, person_token TEXT NOT NULL, display_name TEXT NOT NULL,
            revision INTEGER NOT NULL, server_checked_in INTEGER NOT NULL,
            PRIMARY KEY (event_id, person_token))
        """,
        """
        CREATE TABLE IF NOT EXISTS operations (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,
            event_id TEXT NOT NULL, person_token TEXT NOT NULL, display_name TEXT NOT NULL,
            base_revision INTEGER NOT NULL, window_revision_seen INTEGER NOT NULL,
            recorded_at REAL NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('pending', 'acknowledged', 'held')),
            held_reason TEXT, settled_at REAL,
            UNIQUE (event_id, person_token))
        """,
        """
        CREATE TABLE IF NOT EXISTS recovery_exports (
            export_id TEXT PRIMARY KEY, event_id TEXT NOT NULL,
            created_at REAL NOT NULL, saved_at REAL)
        """,
        """
        CREATE TABLE IF NOT EXISTS recovery_export_ops (
            export_id TEXT NOT NULL REFERENCES recovery_exports (export_id),
            op_id TEXT NOT NULL, PRIMARY KEY (export_id, op_id))
        """,
        """
        CREATE TABLE IF NOT EXISTS roster_versions (
            event_id TEXT PRIMARY KEY, roster_version TEXT NOT NULL)
        """,
        """
        CREATE TABLE IF NOT EXISTS pairing (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            event_id TEXT NOT NULL, participant_address TEXT NOT NULL)
        """,
    ]

    private static func applyFileProtection(_ fileURL: URL) throws {
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
        #if os(iOS)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: fileURL.path)
        #endif
    }
}
