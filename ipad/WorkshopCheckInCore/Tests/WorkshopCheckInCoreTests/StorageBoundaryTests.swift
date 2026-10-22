import Foundation
import XCTest
import WorkshopCheckInCore

/// The names-only rule holds at the storage boundary too, not only for
/// payloads that pass through `DeviceProtocol.decode`.
final class StorageBoundaryTests: XCTestCase {
    private let privateValue = "x.person@example.invalid"

    private func assertPrivacyViolation(_ body: @autoclosure () throws -> Any, _ label: String,
                                        file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), label, file: file, line: line) { error in
            guard case CheckInError.privacyViolation(let message) = error else {
                return XCTFail("\(label): expected privacyViolation, got \(error)", file: file, line: line)
            }
            XCTAssertFalse(message.contains("example.invalid"), "\(label): error copies the private value",
                           file: file, line: line)
        }
    }

    func testTypedRosterWithEmailLikeValuesIsRefusedBeforeAnyChange() throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        var store: CheckInStore? = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store!.applyRoster(roster())
        let opId = savedOpId(try store!.recordCheckIn(eventId: eventA, personToken: alex.personToken))
        let rowsBefore = try store!.rows(eventId: eventA)
        let serverTimeBefore = try store!.estimatedServerTime(eventId: eventA)

        let later = nineAM + 60
        let closed = WindowInfo(state: .closed, revision: 2, openedAt: nineAM)
        let leaky = RosterPerson(personToken: "pt_leak", displayName: privateValue, revision: 1, checkedIn: false)
        let tokenLeak = RosterPerson(personToken: privateValue, displayName: "Lee Park", revision: 1, checkedIn: false)
        let attempts: [(String, RosterSnapshot)] = [
            ("displayName", roster(at: later, window: closed, people: [riya, leaky])),
            ("personToken", roster(at: later, window: closed, people: [tokenLeak])),
            ("eventCode", roster(code: privateValue, at: later, window: closed, people: [riya])),
            ("eventId", roster(privateValue, at: later, window: closed, people: [riya])),
        ]
        for (label, snapshot) in attempts {
            assertPrivacyViolation(try store!.applyRoster(snapshot), label)
        }
        store = nil

        let relaunched = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        XCTAssertEqual(try relaunched.rows(eventId: eventA), rowsBefore, "old roster kept")
        XCTAssertEqual(try relaunched.opId(eventId: eventA, personToken: alex.personToken), opId)
        XCTAssertEqual(try relaunched.outboxSummary(eventId: eventA), OutboxSummary(pending: 1, held: 0, acknowledged: 0))
        XCTAssertTrue(try relaunched.isWindowOpen(eventId: eventA), "window not replaced")
        XCTAssertEqual(try relaunched.estimatedServerTime(eventId: eventA), serverTimeBefore, "clock not replaced")
        XCTAssertThrowsError(try relaunched.isWindowOpen(eventId: privateValue)) {
            XCTAssertEqual($0 as? CheckInError, .unknownEvent)
        }
        let bytes = try Data(contentsOf: dir.storeFile)
        XCTAssertNil(bytes.range(of: Data("example.invalid".utf8)), "private value never reached the file")
    }

    func testPairingWithEmailLikeValuesIsRefusedAndKeepsThePreviousPairing() throws {
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/k3v9")

        assertPrivacyViolation(try store.setPairing(eventId: privateValue, participantAddress: "https://checkin.example.org"),
                               "eventId")
        assertPrivacyViolation(try store.setPairing(eventId: eventA, participantAddress: privateValue), "address")
        XCTAssertEqual(try store.pairing()?.eventId, eventA)
        XCTAssertEqual(try store.pairing()?.participantAddress, "https://checkin.example.org/s/k3v9")
    }
}
