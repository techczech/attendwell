import XCTest
import Network
@testable import NearbyLink

final class NearbyLinkTests: XCTestCase {
    let key = SharedKey(base64url: SharedKey.generate())!

    func testInvitationAcceptedOnlyWithRightKeyNameAndTime() {
        let now = Date()
        let ctx = key.makeInvitation(inviterDisplayName: "iPad", now: now)
        XCTAssertNotNil(key.verifyInvitation(ctx, inviterDisplayName: "iPad", now: now))
        XCTAssertNotNil(key.verifyInvitation(ctx, inviterDisplayName: "iPad", now: now.addingTimeInterval(290)))
        XCTAssertNil(key.verifyInvitation(ctx, inviterDisplayName: "iPad", now: now.addingTimeInterval(310)), "expired")
        XCTAssertNil(key.verifyInvitation(ctx, inviterDisplayName: "Other", now: now), "wrong inviter name")
        let other = SharedKey(base64url: SharedKey.generate())!
        XCTAssertNil(other.verifyInvitation(ctx, inviterDisplayName: "iPad", now: now), "wrong key")
        XCTAssertNil(key.verifyInvitation(nil, inviterDisplayName: "iPad", now: now))
        XCTAssertNil(key.verifyInvitation(Data(count: 56), inviterDisplayName: "iPad", now: now))
    }

    func testSealedMessagesRoundTripAndRejectWrongKey() throws {
        let msgs: [Message] = [
            .hello(Hello(role: "ipad", device: "d", lastSnapshotVersion: 3, unacked: 2)),
            .snapshot(Snapshot(version: 4, workshopId: "w", title: "T", open: true, names: [NameEntry(id: "1", displayName: "A", hidden: false)])),
            .checkin(CheckIn(nameId: "1", at: "2026-11-09T10:00:00.000Z")),
            .ack(["a", "b"]),
        ]
        for m in msgs { XCTAssertEqual(try Message.open(try m.sealed(with: key), with: key), m) }
        let other = SharedKey(base64url: SharedKey.generate())!
        XCTAssertThrowsError(try Message.open(try msgs[2].sealed(with: key), with: other))
    }

    func testTagIsSixteenHexAndKeyDependent() {
        XCTAssertEqual(key.tag.count, 16)
        XCTAssertEqual(key.tag, SharedKey(base64url: key.raw.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_"))!.tag)
        XCTAssertNotEqual(key.tag, SharedKey(base64url: SharedKey.generate())!.tag)
        XCTAssertNil(SharedKey(base64url: "too-short"))
    }

    func testBothMacQRCodesUseNearbyAndOriginalCodeUsesInternet() throws {
        let printable = SharedKey.generate()
        let local = "{\"v\":1,\"workshopId\":\"nearby-test\",\"key\":\"\(printable)\"}"
        let original = "https://checkin.example.org/s/workshop/pair#v=1&code=K7QM-4TZP"
        let extended = original + "%23nearby=" + printable
        for payload in [local, extended] {
            guard case .nearby(let parsed) = NearbyPairingQR(payload) else {
                return XCTFail("Expected nearby pairing")
            }
            XCTAssertTrue(parsed == printable)
        }
        guard case .internet(let parsed) = NearbyPairingQR(original) else {
            return XCTFail("Expected internet pairing")
        }
        XCTAssertEqual(parsed, original)
        XCTAssertNil(NearbyPairingQR(extended + "&other=x"))
        XCTAssertNil(NearbyPairingQR(original + "%23nearby=invalid"))
    }

    func testEightCharacterPairingOverLoopback() throws {
        let durable = SharedKey.generate()
        let server = try ShortCodeHost(key: durable)
        defer { server.stop() }
        XCTAssertEqual(server.code.count, 8)
        XCTAssertNil(ShortCodeClient.normalise("123456789"))
        XCTAssertEqual(ShortCodeClient.normalise(server.code.lowercased()), server.code)
        let ready = expectation(description: "Listener ready")
        server.onReady = { ready.fulfill() }
        server.start()
        wait(for: [ready], timeout: 5)
        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: try XCTUnwrap(server.port))
        func attempt(_ code: String, succeeds: Bool) {
            let done = expectation(description: "Pairing completes")
            let client = ShortCodeClient(code: code) { received in
                XCTAssertTrue(succeeds ? received == durable : received == nil)
                done.fulfill()
            }
            client.connect(to: endpoint, serviceName: server.serviceName)
            wait(for: [done], timeout: 15)
            client.stop()
        }
        attempt(server.code == "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA", succeeds: false)
        attempt(server.code, succeeds: true)
        attempt(server.code, succeeds: false)
    }

    func testQueueSurvivesReload() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nearby-queue-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let q = PendingQueue(url: url)
        try q.append(CheckIn(opId: "1", nameId: "a", at: "x"))
        try q.append(CheckIn(opId: "2", nameId: "b", at: "y", workshopId: "original-workshop"))
        try q.remove(opIds: ["1"])
        XCTAssertEqual(PendingQueue(url: url).items.map(\.opId), ["2"])
        XCTAssertEqual(PendingQueue(url: url).items.first?.workshopId, "original-workshop")
    }

    func testUnreadableQueueIsPreservedAndDoesNotReportASave() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nearby-invalid-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let contents = Data("not a complete queue".utf8)
        try contents.write(to: url)
        let queue = PendingQueue(url: url)
        XCTAssertThrowsError(try queue.append(CheckIn(nameId: "a", at: "x", workshopId: "w")))
        XCTAssertTrue(queue.items.isEmpty)
        XCTAssertEqual(try Data(contentsOf: url), contents)
    }

    func testReconnectKeepsTheQueueAndDoesNotPostponeDiscoveryGuidance() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nearby-retry-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let client = NearbyIPadClient(key: key, deviceName: "Fictional iPad", queue: PendingQueue(url: url))
        let noMac = expectation(description: "No matching Mac after 15 seconds")
        let retry = expectation(description: "Timed recovery builds a fresh session and browser")
        var reasons: [String] = []
        client.onLog = { line in
            reasons.append(line)
            if line.contains("still disconnected after 15 seconds") { retry.fulfill() }
        }
        client.onDiscoveryTimedOut = { timedOut in if timedOut { noMac.fulfill() } }
        client.start()
        defer { client.stop() }
        let operation = try client.checkIn(nameId: "example", workshopId: "fictional")
        client.appDidBecomeActive()
        client.reconnect()
        wait(for: [noMac, retry], timeout: 23)
        XCTAssertTrue(reasons.contains { $0.contains("app returned to foreground") })
        XCTAssertTrue(reasons.contains { $0.contains("Reconnect tapped") })
        XCTAssertEqual(client.pendingCount, 1)
        XCTAssertEqual(PendingQueue(url: url).items, [operation])
    }

    func testClientReconnectsAfterTheHostRebuildsForWakeAndNetworkChanges() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nearby-rebuild-\(UUID().uuidString).json")
        let host = NearbyMacHost(key: key, deviceName: "Fictional Mac")
        let client = NearbyIPadClient(key: key, deviceName: "Fictional iPad", queue: PendingQueue(url: url))
        defer { client.stop(); host.stop() }
        let initial = expectation(description: "Initial connection")
        client.onPeer = { _, state in if state == .connected { initial.fulfill() } }
        host.start()
        client.start()
        guard XCTWaiter.wait(for: [initial], timeout: 20) == .completed else {
            return XCTFail("The local test peers did not connect")
        }
        for reason in ["Mac woke from sleep", "network path changed"] {
            let recovered = expectation(description: "Reconnects after \(reason)")
            client.onPeer = { _, state in if state == .connected { recovered.fulfill() } }
            host.reconnect(reason: reason)
            guard XCTWaiter.wait(for: [recovered], timeout: 20) == .completed else {
                return XCTFail("The iPad did not reconnect after \(reason)")
            }
        }
        let manual = expectation(description: "iPad Reconnect rebuilds and connects again")
        client.onPeer = { _, state in if state == .connected { manual.fulfill() } }
        client.reconnect()
        wait(for: [manual], timeout: 20)
    }
}
