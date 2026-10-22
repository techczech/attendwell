import Foundation
import XCTest
import WorkshopCheckInCore

final class WindowClockTests: XCTestCase {
    private let tenAM = isoDate("2026-10-14T10:00:00Z")
    private let tenToTen = isoDate("2026-10-14T09:50:00Z")

    /// Device wall clock three hours behind the host, synced at 09:50 with closesAt 10:00.
    private func syncedStore(_ dir: TempDirectory, _ clock: FakeClock) throws -> CheckInStore {
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.applyRoster(roster(at: tenToTen, window: openWindow(closesAt: tenAM)))
        return store
    }

    func testExpiryUsesServerTimePlusMonotonicWhileOffline() throws {
        let dir = try TempDirectory()
        let clock = FakeClock(wall: tenToTen - 3 * 3_600)
        let store = try syncedStore(dir, clock)

        clock.advance(9 * 60)
        XCTAssertTrue(try store.isWindowOpen(eventId: eventA))
        XCTAssertNotNil(savedOpId(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)))

        clock.advance(90)
        XCTAssertEqual(try store.estimatedServerTime(eventId: eventA), tenAM + 30)
        XCTAssertFalse(try store.isWindowOpen(eventId: eventA))
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: sam.personToken)) {
            XCTAssertEqual($0 as? CheckInError, .windowClosed)
        }

        clock.setWall(clock.wallNow() - 2 * 3_600) // changing the device clock does not reopen
        XCTAssertFalse(try store.isWindowOpen(eventId: eventA))
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad,
                       "earlier check-ins stay pending")
    }

    func testRebootFallsBackToWallClockPlusLastOffsetAcrossRelaunch() throws {
        let dir = try TempDirectory()
        let clock = FakeClock(wall: tenToTen - 3 * 3_600)
        var store: CheckInStore? = try syncedStore(dir, clock)
        store = nil

        clock.reboot(wallAfter: tenToTen - 3 * 3_600 + 5 * 60)
        store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        XCTAssertEqual(try store!.estimatedServerTime(eventId: eventA), tenToTen + 5 * 60)
        XCTAssertTrue(try store!.isWindowOpen(eventId: eventA))

        clock.advance(6 * 60)
        XCTAssertFalse(try store!.isWindowOpen(eventId: eventA))
        XCTAssertThrowsError(try store!.recordCheckIn(eventId: eventA, personToken: riya.personToken))
    }

    func testExpiredWindowPausesDeliveryWithoutSending() async throws {
        let dir = try TempDirectory()
        let clock = FakeClock(wall: tenToTen)
        let store = try syncedStore(dir, clock)
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        clock.advance(11 * 60)

        let host = makeHost(clock: clock, window: openWindow(closesAt: tenAM))
        let report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report.stop, .windowClosed)
        let sent = await host.receivedOpIds
        XCTAssertTrue(sent.isEmpty)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
    }

    func testHeartbeatClosesAndReopensButLateRepliesCannotReopen() throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.applyRoster(roster())
        XCTAssertThrowsError(try store.applyWindow(eventId: eventB, window: openWindow(), serverTime: nineAM)) {
            XCTAssertEqual($0 as? CheckInError, .unknownEvent)
        }

        let closed = WindowInfo(state: .closed, revision: 2, openedAt: nineAM)
        try store.applyWindow(eventId: eventA, window: closed, serverTime: nineAM + 60)
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken))

        try store.applyWindow(eventId: eventA, window: openWindow(revision: 1), serverTime: nineAM + 30)
        XCTAssertFalse(try store.isWindowOpen(eventId: eventA), "an older observation is ignored")

        try store.applyWindow(eventId: eventA, window: openWindow(revision: 3), serverTime: nineAM + 120)
        XCTAssertNotNil(savedOpId(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)))
    }

    func testOlderWindowRevisionNeverReopensEvenAtTheSameOrLaterServerTime() throws {
        let dir = try TempDirectory()
        let clock = FakeClock()
        var store: CheckInStore? = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store!.applyRoster(roster())
        let closed = WindowInfo(state: .closed, revision: 2, openedAt: nineAM)
        try store!.applyWindow(eventId: eventA, window: closed, serverTime: nineAM + 60)

        try store!.applyWindow(eventId: eventA, window: openWindow(revision: 1), serverTime: nineAM + 60)
        XCTAssertFalse(try store!.isWindowOpen(eventId: eventA), "stale revision at the same server time")

        try store!.applyWindow(eventId: eventA, window: openWindow(revision: 1), serverTime: nineAM + 90)
        XCTAssertFalse(try store!.isWindowOpen(eventId: eventA), "stale revision with a later server time")
        XCTAssertEqual(try store!.estimatedServerTime(eventId: eventA), nineAM + 90, "clock still advances")

        let renamed = RosterPerson(personToken: "pt_lee", displayName: "Lee Park", revision: 1, checkedIn: false)
        XCTAssertTrue(try store!.applyRoster(roster(at: nineAM + 100, window: openWindow(revision: 1),
                                                    people: [alex, renamed])))
        XCTAssertFalse(try store!.isWindowOpen(eventId: eventA), "stale roster arriving after the heartbeat")
        XCTAssertEqual(try store!.rows(eventId: eventA).map(\.displayName), ["Alex Morgan", "Lee Park"],
                       "a newer roster still refreshes names")
        XCTAssertThrowsError(try store!.recordCheckIn(eventId: eventA, personToken: alex.personToken)) {
            XCTAssertEqual($0 as? CheckInError, .windowClosed)
        }
        store = nil

        let relaunched = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        XCTAssertFalse(try relaunched.isWindowOpen(eventId: eventA), "still closed after relaunch")
        try relaunched.applyWindow(eventId: eventA, window: openWindow(revision: 3), serverTime: nineAM + 100)
        XCTAssertTrue(try relaunched.isWindowOpen(eventId: eventA), "a genuine reopen at the same server time")
        XCTAssertNotNil(savedOpId(try relaunched.recordCheckIn(eventId: eventA, personToken: alex.personToken)))
    }
}
