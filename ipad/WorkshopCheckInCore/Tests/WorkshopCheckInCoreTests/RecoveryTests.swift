import Foundation
import XCTest
import WorkshopCheckInCore

final class RecoveryTests: XCTestCase {
    private var dir: TempDirectory!
    private var clock: FakeClock!
    private var store: CheckInStore!

    override func setUpWithError() throws {
        dir = try TempDirectory()
        clock = FakeClock()
        store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/k3v9")
        try store.applyRoster(roster())
    }

    func testExportHoldsNamesAndOperationsOnlyAndIsNotDelivery() async throws {
        let host = makeHost(clock: clock)
        _ = try store.recordCheckIn(eventId: eventA, personToken: jo.personToken) // already confirmed
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        _ = await store.deliverPending(eventId: eventA, via: host) // Alex acknowledged
        let riyaOp = savedOpId(try store.recordCheckIn(eventId: eventA, personToken: riya.personToken))
        let samOp = savedOpId(try store.recordCheckIn(eventId: eventA, personToken: sam.personToken))

        let export = try store.exportRecovery(eventId: eventA, deviceId: "dev_fixture_ipad2")
        XCTAssertTrue(export.fileName.hasSuffix(".attendance-recovery.json"))
        XCTAssertEqual(export.operationCount, 2)
        XCTAssertTrue(DeviceProtocol.privacyViolations(in: export.data).isEmpty)

        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: export.data) as? [String: Any])
        XCTAssertEqual(Set(object.keys),
                       ["format", "version", "eventId", "eventCode", "deviceId", "exportedAt", "operations"])
        let operations = try XCTUnwrap(object["operations"] as? [[String: Any]])
        for operation in operations {
            XCTAssertEqual(Set(operation.keys),
                           ["opId", "personToken", "displayName", "baseRevision", "windowRevisionSeen", "recordedAt"])
        }
        let file = try DeviceProtocol.decode(RecoveryFile.self, from: export.data)
        XCTAssertEqual(file.format, "attendance-recovery")
        XCTAssertEqual(file.operations.map(\.opId), [riyaOp, samOp].map { $0!.uuidString.lowercased() })
        XCTAssertEqual(file.operations.map(\.displayName), ["Riya Shah", "Sam Taylor"])

        try store.confirmRecoverySaved(export.exportId)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 2, "a saved file never claims delivery")
        XCTAssertEqual(try store.status(eventId: eventA, personToken: riya.personToken), .savedOnThisIPad)
        let report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report.acknowledged.count, 2, "saved operations are still sent")
    }

    func testRemovalIsGuardedByASavedRecoveryFileAndAnUpToDatePreview() throws {
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        _ = try store.recordCheckIn(eventId: eventA, personToken: sam.personToken)

        let unsaved = try store.removalPreview(eventId: eventA)
        XCTAssertEqual(unsaved.unsentNames, ["Alex Morgan", "Sam Taylor"])
        XCTAssertFalse(unsaved.unsentCoveredBySavedRecovery)
        XCTAssertThrowsError(try store.removeEventData(confirming: unsaved)) {
            XCTAssertEqual($0 as? CheckInError, .unsentNotRecovered(count: 2))
        }

        let export = try store.exportRecovery(eventId: eventA, deviceId: nil)
        XCTAssertThrowsError(try store.removeEventData(confirming: unsaved), "exported but not saved")
        try store.confirmRecoverySaved(export.exportId)
        XCTAssertThrowsError(try store.removeEventData(confirming: unsaved)) {
            XCTAssertEqual($0 as? CheckInError, .removalPreviewOutdated)
        }

        _ = try store.recordCheckIn(eventId: eventA, personToken: riya.personToken) // not in the file
        let uncovered = try store.removalPreview(eventId: eventA)
        XCTAssertFalse(uncovered.unsentCoveredBySavedRecovery)
        XCTAssertThrowsError(try store.removeEventData(confirming: uncovered)) {
            XCTAssertEqual($0 as? CheckInError, .unsentNotRecovered(count: 3))
        }
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 3)

        try store.confirmRecoverySaved(try store.exportRecovery(eventId: eventA, deviceId: nil).exportId)
        let covered = try store.removalPreview(eventId: eventA)
        XCTAssertTrue(covered.unsentCoveredBySavedRecovery)
        try store.removeEventData(confirming: covered)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA), OutboxSummary(pending: 0, held: 0, acknowledged: 0))
        XCTAssertTrue(try store.rows(eventId: eventA).isEmpty)
        XCTAssertNil(try store.pairing())
    }

    /// Handover removes the names of every event on the iPad, but another
    /// event's unsent check-in without a saved recovery file is kept.
    func testRemovalKeepsAnotherEventsUnsentCheckInButNotItsNamesList() throws {
        try store.applyRoster(roster(eventB, code: "K3V9"))
        let op = savedOpId(try store.recordCheckIn(eventId: eventB, personToken: alex.personToken))
        let preview = try store.removalPreview(eventId: eventA)
        XCTAssertTrue(preview.unsentOpIds.isEmpty)
        try store.removeEventData(confirming: preview)
        XCTAssertEqual(try store.status(eventId: eventB, personToken: alex.personToken), .savedOnThisIPad)
        XCTAssertEqual(try store.opId(eventId: eventB, personToken: alex.personToken), op)
        XCTAssertTrue(try store.rows(eventId: eventB).isEmpty, "names list removed")
        XCTAssertEqual(try store.exportRecovery(eventId: eventB, deviceId: nil).operationCount, 1, "still recoverable")
    }

    /// Earlier events' names, settled check-ins and recovered unsent ones all
    /// go with the handover; nothing names anyone afterwards.
    func testHandoverRemovesTheNamesOfEveryEarlierEvent() async throws {
        let host = makeHost(clock: clock)
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        _ = await store.deliverPending(eventId: eventA, via: host)            // acknowledged
        _ = try store.recordCheckIn(eventId: eventA, personToken: riya.personToken)
        try store.confirmRecoverySaved(try store.exportRecovery(eventId: eventA, deviceId: nil).exportId)
        // The iPad moves on to the next workshop.
        try store.setPairing(eventId: eventB, participantAddress: "https://checkin.example.org/s/k3v9")
        try store.applyRoster(roster(eventB, code: "K3V9", people: [sam]))
        XCTAssertEqual(try store.rows(eventId: eventA).count, 4, "earlier names were cached")

        try store.removeEventData(confirming: try store.removalPreview(eventId: eventB))
        for event in [eventA, eventB] {
            XCTAssertNil(try store.cachedRoster(eventId: event))
            XCTAssertNil(try store.rosterVersion(eventId: event))
            XCTAssertEqual(try store.outboxSummary(eventId: event), OutboxSummary(pending: 0, held: 0, acknowledged: 0))
        }
        XCTAssertTrue(try store.rows(eventId: eventA).isEmpty)
        XCTAssertThrowsError(try store.exportRecovery(eventId: eventA, deviceId: nil), "nothing left of the earlier event")
        XCTAssertNil(try store.pairing())
    }

    func testUnknownRecoveryExportIsRejected() {
        XCTAssertThrowsError(try store.confirmRecoverySaved(UUID())) {
            XCTAssertEqual($0 as? CheckInError, .unknownRecoveryExport)
        }
    }
}
