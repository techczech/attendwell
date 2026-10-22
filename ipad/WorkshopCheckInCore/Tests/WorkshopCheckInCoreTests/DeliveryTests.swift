import Foundation
import XCTest
import WorkshopCheckInCore

final class DeliveryTests: XCTestCase {
    private var dir: TempDirectory!
    private var clock: FakeClock!
    private var store: CheckInStore!

    override func setUpWithError() throws {
        dir = try TempDirectory()
        clock = FakeClock()
        store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.applyRoster(roster())
    }

    private func record(_ person: RosterPerson) throws -> UUID {
        try XCTUnwrap(savedOpId(try store.recordCheckIn(eventId: eventA, personToken: person.personToken)))
    }

    func testSequentialDrainSendsOneOperationAtATimeInRecordedOrder() async throws {
        let ids = [try record(sam), try record(alex), try record(riya)]
        let host = makeHost(clock: clock)
        let report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report, DeliveryReport(acknowledged: ids, held: [], stop: .drained))
        let requests = await host.receivedRequests
        XCTAssertEqual(requests.map(\.operations.count), [1, 1, 1])
        XCTAssertEqual(requests.flatMap(\.operations).map(\.opId), ids.map { $0.uuidString.lowercased() })
        XCTAssertEqual(try store.outboxSummary(eventId: eventA), OutboxSummary(pending: 0, held: 0, acknowledged: 3))
    }

    func testLostReplyResendsTheSameOperationAndCountsOnce() async throws {
        let opId = try record(alex)
        let host = makeHost(clock: clock)
        let transport = FaultyTransport(host: host, faults: [.loseReply, .fail(.timedOut)])

        var report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .transport(.timedOut))
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad)
        report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .transport(.timedOut))
        report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.acknowledged, [opId])

        let sent = await host.receivedOpIds
        XCTAssertEqual(sent, Array(repeating: opId.uuidString.lowercased(), count: 2))
        let applied = await host.appliedCount()
        XCTAssertEqual(applied, 1)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .checkedIn)
    }

    func testCrashAfterSendResendsSameOperationAfterRelaunch() async throws {
        let opId = try record(riya)
        let host = makeHost(clock: clock)
        _ = await store.deliverPending(eventId: eventA, via: FaultyTransport(host: host, faults: [.loseReply]))
        store = nil

        let relaunched = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        XCTAssertEqual(try relaunched.status(eventId: eventA, personToken: riya.personToken), .savedOnThisIPad)
        let report = await relaunched.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report.acknowledged, [opId])
        let applied = await host.appliedCount()
        XCTAssertEqual(applied, 1)
    }

    func testRevocationAndUnusableRepliesKeepOperationsPending() async throws {
        _ = try record(alex)
        let host = makeHost(clock: clock)
        let transport = FaultyTransport(host: host, faults: [.fail(.revoked), .garbage, .emailInReply])
        var report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .transport(.revoked))
        report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .invalidResponse)
        report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .invalidResponse, "a reply carrying an email is rejected at the boundary")
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad)
        report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .drained)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .checkedIn)
    }

    func testDelayedReplyNeitherBlocksSavesNorStartsASecondDelivery() async throws {
        let first = try record(alex)
        let host = makeHost(clock: clock)
        let gate = Gate()
        let transport = DelayedTransport(host: host, gate: gate)
        let store = self.store!
        let running = Task { await store.deliverPending(eventId: eventA, via: transport) }
        await gate.waitForArrivals(1)

        let concurrent = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(concurrent.stop, .alreadyDelivering)
        let second = try record(sam) // saving never waits for the network
        XCTAssertEqual(try store.status(eventId: eventA, personToken: sam.personToken), .savedOnThisIPad)

        await gate.open()
        let report = await running.value
        XCTAssertEqual(report.acknowledged, [first, second])
        let sent = await host.receivedOpIds
        XCTAssertEqual(sent.count, 2)
    }

    func testHeldIsTerminalAndNeverRetried() async throws {
        let host = makeHost(clock: clock)
        await host.undoCheckIn(personToken: riya.personToken) // organiser changed Riya since our roster
        let opId = try record(riya)
        var report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report, DeliveryReport(acknowledged: [], held: [opId], stop: .drained))
        XCTAssertEqual(try store.status(eventId: eventA, personToken: riya.personToken), .withTheOrganiser)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).held, 1)

        report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report, DeliveryReport())
        let sent = await host.receivedOpIds
        XCTAssertEqual(sent.count, 1, "held is not resent")
        XCTAssertEqual(try store.recordCheckIn(eventId: eventA, personToken: riya.personToken),
                       .alreadyDone(.withTheOrganiser, opId: opId))
    }

    func testClosedIsNonTerminalAndSameEventReopeningResumes() async throws {
        let ids = [try record(alex), try record(sam)]
        let host = makeHost(clock: clock)
        await host.close()

        var report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report.stop, .windowClosed)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 2)
        XCTAssertFalse(try store.isWindowOpen(eventId: eventA))
        XCTAssertThrowsError(try store.recordCheckIn(eventId: eventA, personToken: riya.personToken)) {
            XCTAssertEqual($0 as? CheckInError, .windowClosed)
        }
        report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report.stop, .windowClosed)
        var sent = await host.receivedOpIds
        XCTAssertEqual(sent.count, 1, "sending pauses while closed")

        clock.advance(60)
        await host.reopen(closesAt: nil)
        let heartbeat = await host.currentWindow()
        try store.applyWindow(eventId: eventA, window: heartbeat, serverTime: clock.wallNow())
        report = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(report, DeliveryReport(acknowledged: ids, held: [], stop: .drained),
                       "a close and reopen alone never holds")
        sent = await host.receivedOpIds
        XCTAssertEqual(sent.count, 3)
        let requests = await host.receivedRequests
        XCTAssertEqual(requests.last?.operations.first?.windowRevisionSeen, 1, "window revision is audit only")
        XCTAssertGreaterThan(heartbeat.revision, 1)
    }

    func testStaleRosterAfterAcknowledgementNeverDowngrades() async throws {
        let host = makeHost(clock: clock)
        let before = await host.roster() // an older reply: Alex not checked in
        clock.advance(5)
        try store.applyRoster(await host.roster())
        _ = try record(alex)
        _ = await store.deliverPending(eventId: eventA, via: host)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .checkedIn)

        XCTAssertFalse(try store.applyRoster(before), "older snapshot ignored")
        var lagging = before
        lagging.serverTime = clock.wallNow() + 1
        XCTAssertTrue(try store.applyRoster(lagging))
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .checkedIn,
                       "acknowledged outranks a roster that has not caught up")
    }

    func testPruningNeedsSevenDaysAndRosterConfirmation() async throws {
        let host = makeHost(clock: clock)
        await host.undoCheckIn(personToken: riya.personToken)
        _ = try record(alex)
        _ = try record(riya) // will be held
        _ = await store.deliverPending(eventId: eventA, via: host)
        _ = try record(sam) // stays pending
        XCTAssertEqual(try store.outboxSummary(eventId: eventA), OutboxSummary(pending: 1, held: 1, acknowledged: 1))

        clock.advance(6 * 86_400)
        XCTAssertEqual(try store.pruneAcknowledged(), 0, "too young")
        clock.advance(2 * 86_400)
        XCTAssertEqual(try store.pruneAcknowledged(), 0, "roster has not confirmed Alex yet")

        var confirmed = await host.roster()
        confirmed.serverTime = clock.wallNow()
        try store.applyRoster(confirmed)
        XCTAssertEqual(try store.pruneAcknowledged(), 1)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .checkedIn)

        clock.advance(60 * 86_400)
        XCTAssertEqual(try store.pruneAcknowledged(), 0)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA), OutboxSummary(pending: 1, held: 1, acknowledged: 0),
                       "pending and held are never pruned")
    }
}
