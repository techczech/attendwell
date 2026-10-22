import Foundation
import SQLite3
import XCTest
import WorkshopCheckInCore

final class RecordingTests: XCTestCase {
    func testSaveIsDurableAndRelaunchKeepsTheSameOperation() async throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        var store: CheckInStore? = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store!.applyRoster(roster())
        let opId = savedOpId(try store!.recordCheckIn(eventId: eventA, personToken: alex.personToken))
        XCTAssertEqual(try store!.storageSettings(),
                       .init(journalMode: "delete", synchronous: "2"), "synchronous=FULL, disk journal")
        store = nil

        let relaunched = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        XCTAssertEqual(try relaunched.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad)
        XCTAssertEqual(try relaunched.opId(eventId: eventA, personToken: alex.personToken), opId)
        XCTAssertEqual(try relaunched.outboxSummary(eventId: eventA).pending, 1)
        XCTAssertEqual(try relaunched.storageSettings().synchronous, "2")

        let host = makeHost(clock: clock)
        let report = await relaunched.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report.acknowledged, [opId!])
        let sent = await host.receivedOpIds
        XCTAssertEqual(sent, [opId!.uuidString.lowercased()])
        XCTAssertEqual(try relaunched.status(eventId: eventA, personToken: alex.personToken), .checkedIn)
    }

    func testOperationIdIsUUIDv4() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        try store.applyRoster(roster())
        let opId = try XCTUnwrap(savedOpId(try store.recordCheckIn(eventId: eventA, personToken: sam.personToken)))
        let text = opId.uuidString.lowercased()
        XCTAssertEqual(Array(text)[14], "4", "version nibble")
        XCTAssertTrue("89ab".contains(Array(text)[19]), "RFC 4122 variant")
    }

    func testDuplicateTapReusesTheOperation() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        try store.applyRoster(roster())
        let opId = savedOpId(try store.recordCheckIn(eventId: eventA, personToken: riya.personToken))
        XCTAssertEqual(try store.recordCheckIn(eventId: eventA, personToken: riya.personToken),
                       .alreadyDone(.savedOnThisIPad, opId: opId))
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
    }

    func testConcurrentTapsAcrossConnectionsShareOneOperation() throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        let first = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        let second = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try first.applyRoster(roster())
        let lock = NSLock()
        var outcomes: [RecordOutcome] = []
        var errors: [Error] = []
        DispatchQueue.concurrentPerform(iterations: 24) { index in
            let store = index.isMultiple(of: 2) ? first : second
            do {
                let outcome = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
                lock.lock(); outcomes.append(outcome); lock.unlock()
            } catch {
                lock.lock(); errors.append(error); lock.unlock()
            }
        }
        XCTAssertTrue(errors.isEmpty, "\(errors)")
        let saved = outcomes.compactMap { outcome -> UUID? in
            if case .saved(let id) = outcome { return id } else { return nil }
        }
        XCTAssertEqual(saved.count, 1)
        XCTAssertEqual(Set(outcomes.filter { $0 != .saved(opId: saved[0]) }),
                       [.alreadyDone(.savedOnThisIPad, opId: saved[0])])
        XCTAssertEqual(try first.outboxSummary(eventId: eventA).pending, 1)
    }

    func testInsertFailureReportsErrorAndNoSave() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        try store.applyRoster(roster())
        rawSQL(dir.storeFile, """
            CREATE TRIGGER fail_insert BEFORE INSERT ON operations
            BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END;
            """)
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)) { error in
            guard case CheckInError.storage = error else { return XCTFail("\(error)") }
        }
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .notCheckedIn)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA), OutboxSummary(pending: 0, held: 0, acknowledged: 0))

        rawSQL(dir.storeFile, "DROP TRIGGER fail_insert")
        XCTAssertNotNil(savedOpId(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)))
    }

    func testCommitFailureRollsBackAndReportsNoSave() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        try store.applyRoster(roster())
        // Another connection holds a read lock, so COMMIT cannot take the
        // exclusive lock and fails after the busy timeout.
        let reader = rawSQL(dir.storeFile, "BEGIN; SELECT COUNT(*) FROM operations;", keepOpen: true)
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: sam.personToken)) { error in
            guard case CheckInError.storage = error else { return XCTFail("\(error)") }
        }
        sqlite3_exec(reader, "ROLLBACK", nil, nil, nil)
        sqlite3_close(reader)

        XCTAssertEqual(try store.status(eventId: eventA, personToken: sam.personToken), .notCheckedIn)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 0)
        XCTAssertNotNil(savedOpId(try store.recordCheckIn(eventId: eventA, personToken: sam.personToken)))
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
    }

    func testUnknownTapsAndServerConfirmedRows() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)) {
            XCTAssertEqual($0 as? CheckInError, .unknownEvent)
        }
        try store.applyRoster(roster())
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: "pt_nobody")) {
            XCTAssertEqual($0 as? CheckInError, .unknownPerson)
        }
        XCTAssertEqual(try store.recordCheckIn(eventId: eventA, personToken: jo.personToken),
                       .alreadyDone(.checkedIn, opId: nil))
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 0)
    }

    func testRowStatusPrecedenceIncludingOfflineConfirmedRows() async throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.applyRoster(roster())
        let host = makeHost(clock: clock)
        await host.undoCheckIn(personToken: riya.personToken) // device copy of Riya is now stale
        _ = try store.recordCheckIn(eventId: eventA, personToken: riya.personToken)
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        _ = await store.deliverPending(eventId: eventA, via: host) // Riya held, Alex applied
        _ = try store.recordCheckIn(eventId: eventA, personToken: sam.personToken)

        // Offline from here: delivery fails, confirmed rows never downgrade.
        let offline = FaultyTransport(host: host, faults: [.fail(.unreachable)])
        let report = await store.deliverPending(eventId: eventA, via: offline)
        XCTAssertEqual(report.stop, .transport(.unreachable))

        let statuses = Dictionary(uniqueKeysWithValues: try store.rows(eventId: eventA).map { ($0.displayName, $0.status) })
        XCTAssertEqual(statuses, ["Alex Morgan": .checkedIn, "Jo Okafor": .checkedIn,
                                  "Riya Shah": .withTheOrganiser, "Sam Taylor": .savedOnThisIPad])
        XCTAssertEqual(try store.rows(eventId: eventA).map(\.displayName),
                       ["Alex Morgan", "Jo Okafor", "Riya Shah", "Sam Taylor"])
        XCTAssertFalse(RowStatus.notCheckedIn.isDone)
        XCTAssertTrue([RowStatus.checkedIn, .savedOnThisIPad, .withTheOrganiser].allSatisfy(\.isDone))
    }

    func testEventsAreIsolated() async throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.applyRoster(roster(eventA))
        try store.applyRoster(roster(eventB, code: "K3V9"))
        let inA = savedOpId(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken))
        XCTAssertEqual(try store.status(eventId: eventB, personToken: alex.personToken), .notCheckedIn)
        let inB = savedOpId(try store.recordCheckIn(eventId: eventB, personToken: alex.personToken))
        XCTAssertNotEqual(inA, inB)

        let hostA = makeHost(eventA, clock: clock)
        let report = await store.deliverPending(eventId: eventA, via: hostA)
        XCTAssertEqual(report.acknowledged, [inA!])
        let sentToA = await hostA.receivedOpIds
        XCTAssertEqual(sentToA, [inA!.uuidString.lowercased()])
        XCTAssertEqual(try store.status(eventId: eventB, personToken: alex.personToken), .savedOnThisIPad)
        XCTAssertEqual(try store.outboxSummary(eventId: eventB).pending, 1)

        try store.applyRoster(roster(eventB, code: "K3V9", at: nineAM + 60, people: [riya]))
        XCTAssertEqual(try store.outboxSummary(eventId: eventB).pending, 1, "roster changes never drop operations")
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .checkedIn)
    }

    func testAddressChangeAndDifferentEventPairingKeepRecords() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/k3v9")
        try store.applyRoster(roster())
        let opId = savedOpId(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken))

        try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/new1")
        XCTAssertEqual(try store.pairing()?.participantAddress, "https://checkin.example.org/s/new1")
        XCTAssertEqual(try store.opId(eventId: eventA, personToken: alex.personToken), opId)

        XCTAssertThrowsError(try store.setPairing(eventId: eventB, participantAddress: "https://other.example.org")) {
            XCTAssertEqual($0 as? CheckInError, .differentEventHasUnsent(count: 1))
        }
        XCTAssertEqual(try store.pairing()?.eventId, eventA)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)

        // An exported but unsaved file is not enough; a saved one is.
        let export = try store.exportRecovery(eventId: eventA, deviceId: nil)
        XCTAssertThrowsError(try store.setPairing(eventId: eventB, participantAddress: "https://other.example.org"))
        try store.confirmRecoverySaved(export.exportId)
        try store.setPairing(eventId: eventB, participantAddress: "https://other.example.org")
        XCTAssertEqual(try store.pairing()?.eventId, eventB)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad,
                       "re-pairing never deletes another event's rows")
    }
}
