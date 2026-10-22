import Foundation
import XCTest
import WorkshopCheckInCore

/// Lints the PROVISIONAL fixtures in `contract/device-v1/` at the schema boundary.
final class ContractFixtureTests: XCTestCase {
    private var fixtureDirectory: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() } // file → tests → package → ipad
        return url.appendingPathComponent("contract/device-v1", isDirectory: true)
    }

    func testEveryFixtureIsMarkedProvisionalNamesOnlyAndDecodes() throws {
        let files = try FileManager.default.contentsOfDirectory(at: fixtureDirectory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        XCTAssertGreaterThanOrEqual(files.count, 5)

        for file in files {
            let name = file.lastPathComponent
            let data = try Data(contentsOf: file)
            XCTAssertEqual(DeviceProtocol.privacyViolations(in: data), [], name)
            let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any], name)
            XCTAssertTrue((object["_provisional"] as? String)?.hasPrefix("PROVISIONAL") ?? false, name)

            switch name {
            case let n where n.hasPrefix("heartbeat-request"):
                _ = try DeviceProtocol.decode(HeartbeatReport.self, from: data)
            case let n where n.hasPrefix("heartbeat-response"):
                let reply = try DeviceProtocol.decode(HeartbeatReply.self, from: data)
                XCTAssertTrue(RosterSnapshot.isValidRosterVersion(reply.rosterVersion), name)
            case let n where n.hasPrefix("error-"):
                XCTAssertNotNil(object["error"] as? String, name)
            case let n where n.hasPrefix("hello-request"):
                struct Hello: Decodable { let code: String; let organiserProof: OrganiserProofRequest? }
                _ = try DeviceProtocol.decode(Hello.self, from: data)
            case let n where n.hasPrefix("hello-reply"):
                _ = try DeviceProtocol.decode(PairingOffer.self, from: data)
            case let n where n.hasPrefix("pairing-offer"):
                _ = try DeviceProtocol.decode(PairingOffer.self, from: data)
            case let n where n.hasPrefix("pairing-success"):
                _ = try DeviceProtocol.decode(PairingSuccess.self, from: data)
            case let n where n.hasPrefix("roster"):
                let roster = try DeviceProtocol.decode(RosterSnapshot.self, from: data)
                XCTAssertFalse(roster.people.isEmpty, name)
                XCTAssertTrue(RosterSnapshot.isValidRosterVersion(roster.rosterVersion ?? ""), name)
                // Host person tokens: "pt_" + 24 hex characters.
                XCTAssertTrue(roster.people.allSatisfy { $0.personToken.range(of: "^pt_[0-9a-f]{24}$",
                    options: .regularExpression) != nil }, name)
            case let n where n.hasPrefix("operations-request"):
                let request = try DeviceProtocol.decode(OperationsRequest.self, from: data)
                XCTAssertTrue(request.operations.allSatisfy { UUID(uuidString: $0.opId) != nil }, name)
            case let n where n.hasPrefix("operations-response"):
                _ = try DeviceProtocol.decode(OperationsResponse.self, from: data)
            case let n where n.hasPrefix("recovery"):
                let recovery = try DeviceProtocol.decode(RecoveryFile.self, from: data)
                XCTAssertEqual(recovery.format, DeviceProtocol.recoveryFormat, name)
            default:
                XCTFail("unclassified fixture \(name)")
            }
        }
    }

    /// Pins the organiser-proof algorithm shared with the host: the recorded
    /// six-line proof (bound to the participant origin) is reproduced exactly
    /// from the recorded key, request and the origin of the address the iPad
    /// asked, and a change to any signed field, the origin included, fails.
    func testRecordedOriginBoundOrganiserProofIsReproducedExactly() throws {
        struct Hello: Decodable { let code: String; let organiserProof: OrganiserProofRequest }
        struct Inputs: Decodable { let organiserProofKey: String; let deviceId: String; let code: String
                                   let nonce: String; let origin: String }
        struct Reply: Decodable { let organiserProof: String; let _inputs: Inputs }
        let success = try DeviceProtocol.decode(PairingSuccess.self,
            from: Data(contentsOf: fixtureDirectory.appendingPathComponent("pairing-success.example.json")))
        let request = try DeviceProtocol.decode(Hello.self,
            from: Data(contentsOf: fixtureDirectory.appendingPathComponent("hello-request-organiser-proof.example.json")))
        let replyData = try Data(contentsOf: fixtureDirectory.appendingPathComponent(
            "hello-reply-organiser-proof-origin-bound.example.json"))
        let offer = try DeviceProtocol.decode(PairingOffer.self, from: replyData)
        let reply = try JSONDecoder().decode(Reply.self, from: replyData)
        let key = try XCTUnwrap(success.organiserProofKey), inputs = reply._inputs
        XCTAssertTrue(OrganiserProof.isValidKey(key))
        XCTAssertEqual(inputs.organiserProofKey, key)
        XCTAssertEqual(inputs.deviceId, success.deviceId)
        XCTAssertEqual(request.organiserProof.deviceId, success.deviceId)
        XCTAssertEqual(request.organiserProof.nonce, inputs.nonce)
        XCTAssertEqual(request.code, inputs.code)
        // The iPad derives the origin from the QR it scanned, not from the reply.
        let (address, code) = try ParticipantAddress.pairingQR(inputs.origin + "/pair#v=1&code=K7QM-4TZP")
        XCTAssertEqual(address.proofOrigin, inputs.origin)
        XCTAssertEqual(code, inputs.code)
        let pinned = "2933b19538938fcfcfdea6c262e724291a2d15074b533d7375cfa070ffb1847c"
        XCTAssertEqual(reply.organiserProof, pinned)
        XCTAssertEqual(OrganiserProof.sign(key: key, deviceId: success.deviceId, eventId: offer.eventId,
                                           code: code, nonce: inputs.nonce, origin: address.proofOrigin), pinned)
        XCTAssertEqual(String(decoding: OrganiserProof.message(deviceId: success.deviceId, eventId: offer.eventId,
            code: code, nonce: inputs.nonce, origin: inputs.origin), as: UTF8.self),
            ["attendwell-organiser-proof-v1", "dev_fixture_ipad2", "evt_fixture_spring", "K7QM4TZP",
             inputs.nonce, "https://quiet-river-fixture.trycloudflare.com"].joined(separator: "\n"))
        XCTAssertTrue(OrganiserProof.verify(pinned, key: key, deviceId: success.deviceId, eventId: offer.eventId,
                                            code: code, nonce: inputs.nonce, origin: inputs.origin))
        for origin in ["https://someone-elses-server.example.net", inputs.origin + "/", inputs.origin + ":8443",
                       "https://bright-meadow-fixture.trycloudflare.com"] {
            XCTAssertFalse(OrganiserProof.verify(pinned, key: key, deviceId: success.deviceId, eventId: offer.eventId,
                                                 code: code, nonce: inputs.nonce, origin: origin), origin)
        }
        XCTAssertFalse(OrganiserProof.verify(pinned, key: key, deviceId: success.deviceId, eventId: "evt_fixture_autumn",
                                             code: code, nonce: inputs.nonce, origin: inputs.origin))
        XCTAssertFalse(OrganiserProof.verify(pinned.uppercased(), key: key, deviceId: success.deviceId,
                                             eventId: offer.eventId, code: code, nonce: inputs.nonce, origin: inputs.origin))
    }

    /// The signed origin is the WHATWG `URL.origin` of the scanned address,
    /// as the host computes `new URL(participantOrigin).origin`: lower-case
    /// scheme and host, the port only when it is not 443, never a path.
    func testProofOriginIsTheWHATWGOriginOfTheScannedAddress() throws {
        let cases: [(String, String)] = [
            ("https://Quiet-River-Fixture.TryCloudflare.com/pair#v=1&code=K7QM4TZP",
             "https://quiet-river-fixture.trycloudflare.com"),
            ("HTTPS://checkin.example.org:8443/pair#v=1&code=K7QM4TZP", "https://checkin.example.org:8443"),
            ("https://checkin.example.org:443/pair#v=1&code=K7QM4TZP", "https://checkin.example.org"),
            ("https://checkin.example.org:0443/pair#v=1&code=K7QM4TZP", "https://checkin.example.org"),
            ("https://checkin.example.org:08443/pair#v=1&code=K7QM4TZP", "https://checkin.example.org:8443"),
            ("https://checkin.example.org/s/Ab12/pair#v=1&code=K7QM4TZP", "https://checkin.example.org"),
            ("https://192.168.1.20:8443/pair#v=1&code=K7QM4TZP", "https://192.168.1.20:8443"),
            ("https://[::1]:8443/pair#v=1&code=K7QM4TZP", "https://[::1]:8443"),
            ("https://[2001:DB8:0:0:1:0:0:1]/pair#v=1&code=K7QM4TZP", "https://[2001:db8::1:0:0:1]"),
            ("https://[0:0:0:0:0:0:0:0]:443/pair#v=1&code=K7QM4TZP", "https://[::]"),
            ("https://[1:0:0:2:0:0:0:3]/pair#v=1&code=K7QM4TZP", "https://[1:0:0:2::3]"),
            ("https://[1:2:3:4:5:6:7:0]/pair#v=1&code=K7QM4TZP", "https://[1:2:3:4:5:6:7:0]"),
            ("https://[::ffff:192.168.1.20]/pair#v=1&code=K7QM4TZP", "https://[::ffff:c0a8:114]"),
        ]
        for (qr, origin) in cases {
            XCTAssertEqual(try ParticipantAddress.pairingQR(qr).0.proofOrigin, origin, qr)
        }
        for base in ["https://checkin.example.org/s/Ab12/", "https://checkin.example.org/", "https://checkin.example.org"] {
            XCTAssertEqual(try ParticipantAddress(base).proofOrigin, "https://checkin.example.org", base)
        }
        // The endpoints still keep the session prefix; only the signed origin drops it.
        XCTAssertEqual(try ParticipantAddress("https://checkin.example.org/s/Ab12/").endpoint("pair").absoluteString,
                       "https://checkin.example.org/s/Ab12/device/v1/pair")
        // Hosts whose WHATWG form this code would have to guess at are refused.
        for base in ["https://127.1/", "https://0x7f.0.0.1/", "https://127.000.0.1/", "https://1.2.3.256/",
                     "https://1.2.3.4./", "https://Ex%41mple.org/", "https://b%C3%BCcher.de/",
                     "https://[fe80::1%25en0]/", "https://[::g]/", "https://[1:2:3:4:5:6:7:8:9]/"] {
            XCTAssertThrowsError(try ParticipantAddress(base), base)
        }
    }

    func testFixtureRosterDrivesTheStore() throws {
        let data = try Data(contentsOf: fixtureDirectory.appendingPathComponent("roster.example.json"))
        let snapshot = try DeviceProtocol.decode(RosterSnapshot.self, from: data)
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock(wall: snapshot.serverTime))
        try store.applyRoster(snapshot)
        let rows = try store.rows(eventId: snapshot.eventId)
        XCTAssertEqual(rows.map(\.displayName), ["Alex Morgan", "Jo Okafor", "Riya Shah"])
        XCTAssertEqual(rows.map(\.status), [.notCheckedIn, .checkedIn, .notCheckedIn])
    }

    func testBoundaryRejectsEmailBookingAndSourceFields() {
        let payloads = [
            #"{"people":[{"personToken":"pt_x","displayName":"X","email":"x"}]}"#,
            #"{"people":[{"personToken":"pt_x","displayName":"X","bookingStatus":"confirmed"}]}"#,
            #"{"people":[{"personToken":"pt_x","displayName":"X","source":"import"}]}"#,
            #"{"people":[{"personToken":"pt_x","displayName":"x.person@example.invalid"}]}"#,
            #"{"nested":{"Contact_E-mail":"none"}}"#,
            "not json",
        ]
        for payload in payloads {
            let data = Data(payload.utf8)
            XCTAssertFalse(DeviceProtocol.privacyViolations(in: data).isEmpty, payload)
            XCTAssertThrowsError(try DeviceProtocol.decode(RosterSnapshot.self, from: data), payload)
        }
    }

    func testFractionalAndWholeSecondTimestampsDecodeAndMillisecondsSurviveRoundTrip() throws {
        let response = try DeviceProtocol.decode(OperationsResponse.self, from: Data("""
            {"eventId":"evt_fixture_spring","serverTime":"2026-10-14T09:02:11.123Z",
             "window":{"state":"open","revision":1,"openedAt":"2026-10-14T08:45:00Z",
                       "closesAt":"2026-10-14T10:00:00.5Z"},
             "results":[]}
            """.utf8))
        XCTAssertEqual(response.serverTime.timeIntervalSince(isoDate("2026-10-14T09:02:11Z")), 0.123, accuracy: 0.0005)
        XCTAssertEqual(response.window.openedAt, isoDate("2026-10-14T08:45:00Z"))
        XCTAssertEqual(try XCTUnwrap(response.window.closesAt).timeIntervalSince(isoDate("2026-10-14T10:00:00Z")),
                       0.5, accuracy: 0.0005)

        let encoded = try DeviceProtocol.encode(response)
        let text = String(decoding: encoded, as: UTF8.self)
        XCTAssertTrue(text.contains("\"2026-10-14T09:02:11.123Z\""), text)
        XCTAssertTrue(text.contains("\"2026-10-14T10:00:00.500Z\""), text)
        let again = try DeviceProtocol.decode(OperationsResponse.self, from: encoded)
        XCTAssertEqual(again.serverTime.timeIntervalSince(response.serverTime), 0, accuracy: 0.0005)
        XCTAssertEqual(try DeviceProtocol.encode(again), encoded, "stable across repeated round trips")

        let request = try DeviceProtocol.decode(OperationsRequest.self, from: Data("""
            {"eventId":"evt_fixture_spring","operations":[{"opId":"0b6f2c7e-3a1d-4c5e-9f8a-1b2c3d4e5f60",
             "personToken":"pt_alex","baseRevision":1,"windowRevisionSeen":1,
             "recordedAt":"2026-10-14T09:02:10.007Z"}]}
            """.utf8))
        let requestText = String(decoding: try DeviceProtocol.encode(request), as: UTF8.self)
        XCTAssertTrue(requestText.contains("\"2026-10-14T09:02:10.007Z\""), requestText)
        XCTAssertThrowsError(try DeviceProtocol.decode(OperationsRequest.self, from: Data("""
            {"eventId":"e","operations":[{"opId":"x","personToken":"p","baseRevision":1,"windowRevisionSeen":1,
             "recordedAt":"14 October 2026"}]}
            """.utf8)), "non-ISO dates are still rejected")
    }

    func testStoreTimestampsKeepMillisecondsInRecoveryFiles() throws {
        let dir = try TempDirectory()
        let clock = FakeClock(wall: nineAM + 0.25)
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        try store.applyRoster(roster())
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        let export = try store.exportRecovery(eventId: eventA, deviceId: nil)
        let text = String(decoding: export.data, as: UTF8.self)
        XCTAssertTrue(text.contains("\"2026-10-14T09:00:00.250Z\""), text)
        let file = try DeviceProtocol.decode(RecoveryFile.self, from: export.data)
        XCTAssertEqual(file.operations.first?.recordedAt.timeIntervalSince(nineAM) ?? 0, 0.25, accuracy: 0.0005)
    }

    func testEncodingRefusesEmailLikeValues() {
        let person = RosterPerson(personToken: "pt_x", displayName: "x.person@example.invalid", revision: 1, checkedIn: false)
        XCTAssertThrowsError(try DeviceProtocol.encode(person)) { error in
            guard case CheckInError.privacyViolation = error else { return XCTFail("\(error)") }
        }
    }
}
