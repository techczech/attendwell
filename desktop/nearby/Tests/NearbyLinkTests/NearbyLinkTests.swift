import XCTest
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

    func testQueueSurvivesReload() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("nearby-queue-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }
        let q = PendingQueue(url: url)
        q.append(CheckIn(opId: "1", nameId: "a", at: "x")); q.append(CheckIn(opId: "2", nameId: "b", at: "y"))
        q.remove(opIds: ["1"])
        XCTAssertEqual(PendingQueue(url: url).items.map(\.opId), ["2"])
    }
}
