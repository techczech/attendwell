import Foundation
import XCTest
import WorkshopCheckInCore

private let pairingOffer = PairingOffer(eventId: eventA, eventCode: "7Q2M", eventName: "Spring Workshop",
                                       eventDate: "14 October 2026", deviceLabel: "iPad 2")
private let fixtureCredential = "dc_" + String(repeating: "a", count: 43)
private let fixtureAddress = "https://checkin.example.org/s/k3v9"

final class PairingTests: XCTestCase {
    func testOldProofNeverLeavesItsOriginalHostAndSessionPrefix() async throws {
        for address in [fixtureAddress + "/", "https://other.example.org/s/k3v9", "https://checkin.example.org/s/other"] {
            let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
            _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: fixtureAddress)
            _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
            let old = ActiveCredential(credential: "dc_old_fixture", address: fixtureAddress, offer: pairingOffer, deviceId: "dev_old")
            let vault = FixtureCredentialVault(CredentialState(active: old))
            let host = FixturePairingTransport(offer: pairingOffer, faults: [.loseReply])
            let pairing = PairingCoordinator(vault: vault, store: store, transport: host)
            try await pairing.begin(address: address, code: "K7QM4TZP", confirmed: pairingOffer, authority: .organiserPIN)
            do { _ = try await pairing.retry(); XCTFail("lost reply") } catch {}
            _ = try await pairing.retry()
            let expected: String? = address == fixtureAddress + "/" ? old.credential : nil
            let proofs = await host.oldProofs
            XCTAssertEqual(proofs, [expected, expected])
            XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
            XCTAssertEqual(try store.pairing()?.participantAddress, address)
        }
    }

    func testPromotionWriteFailureResumesDefiniteSuccessWithoutAnotherHostRequest() async throws {
        let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        _ = try store.applyRoster(roster()); _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        let old = ActiveCredential(credential: "dc_old_fixture", address: fixtureAddress, offer: pairingOffer, deviceId: "dev_old")
        let vault = FailingCredentialVault(CredentialState(active: old), failWrite: 3)
        let host = FixturePairingTransport(offer: pairingOffer)
        let first = PairingCoordinator(vault: vault, store: store, transport: host, generate: { fixtureCredential })
        try await first.begin(address: fixtureAddress, code: "K7QM4TZP", confirmed: pairingOffer, authority: .organiserPIN)
        do { _ = try await first.retry(); XCTFail("Keychain promotion should fail") } catch {}
        XCTAssertEqual(try vault.read().active, old)
        XCTAssertNotNil(try vault.read().pending?.definiteSuccess)
        let relaunched = PairingCoordinator(vault: vault, store: store, transport: host)
        let active = try await relaunched.retry()
        XCTAssertEqual(active.credential, fixtureCredential)
        let hashes = await host.submittedHashes, proofs = await host.oldProofs
        XCTAssertEqual(hashes.count, 1); XCTAssertEqual(proofs, [old.credential])
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
    }

    func testPendingWriteFailureNeverSpendsCode() async throws {
        let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        let vault = FailingCredentialVault(CredentialState(), failWrite: 1)
        let host = FixturePairingTransport(offer: pairingOffer)
        let pairing = PairingCoordinator(vault: vault, store: store, transport: host, generate: { fixtureCredential })
        do { try await pairing.begin(address: fixtureAddress, code: "K7QM4TZP", confirmed: pairingOffer); XCTFail() } catch {}
        XCTAssertNil(try vault.read().pending)
        let hashes = await host.submittedHashes; XCTAssertTrue(hashes.isEmpty)
    }

    func testHTTPFailuresPauseDeliveryWithoutChangingOperation() async throws {
        for (status, failure) in [(401, TransportFailure.revoked), (409, .eventMoved), (426, .updateNeeded)] {
            let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
            _ = try store.applyRoster(roster())
            let outcome = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
            let client = CapturingClient(response: NativeResponse(status: status, body: Data("{}".utf8)))
            let active = ActiveCredential(credential: fixtureCredential, address: fixtureAddress, offer: pairingOffer, deviceId: "dev_fixture")
            let report = await store.deliverPending(eventId: eventA, via: NativeDeviceAPI(client: client, active: active))
            XCTAssertEqual(report.stop, .transport(failure))
            XCTAssertEqual(try store.opId(eventId: eventA, personToken: alex.personToken), savedOpId(outcome))
            XCTAssertEqual(try store.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad)
        }
    }

    func testLostReplyAndRelaunchReuseHashAndPromoteOnlySuccess() async throws {
        let directory = try TempDirectory(); let store = try CheckInStore(fileURL: directory.storeFile, clock: FakeClock())
        _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: fixtureAddress)
        let op = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        let vault = FixtureCredentialVault()
        let host = FixturePairingTransport(offer: pairingOffer, faults: [.loseReply])
        let first = PairingCoordinator(vault: vault, store: store, transport: host, generate: { fixtureCredential })
        try await first.begin(address: fixtureAddress, code: "K7QM-4TZP", confirmed: pairingOffer)
        do { _ = try await first.retry(); XCTFail("lost response") } catch { XCTAssertEqual(error as? TransportFailure, .timedOut) }
        XCTAssertNil(try vault.read().active); XCTAssertEqual(try vault.read().pending?.credential, fixtureCredential)
        let relaunched = PairingCoordinator(vault: vault, store: store, transport: host)
        let active = try await relaunched.retry()
        XCTAssertEqual(active.credential, fixtureCredential); XCTAssertNil(try vault.read().pending)
        let hashes = await host.submittedHashes
        XCTAssertEqual(hashes, [DeviceCredential.hash(fixtureCredential), DeviceCredential.hash(fixtureCredential)])
        XCTAssertEqual(try store.recordCheckIn(eventId: eventA, personToken: alex.personToken),
                       .alreadyDone(.savedOnThisIPad, opId: savedOpId(op)))
    }

    func testDefiniteGenericRejectionClearsOnlyPendingAndKeepsOldCredentialAndAttendance() async throws {
        let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        _ = try store.applyRoster(roster()); _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        let old = ActiveCredential(credential: "dc_old_fixture", address: fixtureAddress, offer: pairingOffer, deviceId: "dev_old")
        let vault = FixtureCredentialVault(CredentialState(active: old))
        let host = FixturePairingTransport(offer: pairingOffer, faults: [.invalidCode])
        let pairing = PairingCoordinator(vault: vault, store: store, transport: host, generate: { fixtureCredential })
        try await pairing.begin(address: fixtureAddress, code: "K7QM4TZP", confirmed: pairingOffer, authority: .organiserPIN)
        do { _ = try await pairing.retry(); XCTFail() } catch { XCTAssertEqual(error as? PairingError, .invalidOrExpiredCode) }
        XCTAssertNil(try vault.read().pending); XCTAssertEqual(try vault.read().active, old)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
    }

    func test401409426AndWrongEventNeverPromoteOrRemoveCheckIns() async throws {
        for fault in [FixturePairingTransport.Fault.failure(.revoked), .failure(.eventMoved), .failure(.updateNeeded), .wrongEvent] {
            let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
            _ = try store.applyRoster(roster()); _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
            let vault = FixtureCredentialVault()
            let pairing = PairingCoordinator(vault: vault, store: store,
                transport: FixturePairingTransport(offer: pairingOffer, faults: [fault]), generate: { fixtureCredential })
            try await pairing.begin(address: fixtureAddress, code: "K7QM4TZP", confirmed: pairingOffer)
            do { _ = try await pairing.retry(); XCTFail() } catch {}
            XCTAssertNotNil(try vault.read().pending); XCTAssertNil(try vault.read().active)
            XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
        }
    }

    func testDifferentEventBlockedBeforeAnyCredentialWrite() async throws {
        let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: fixtureAddress)
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        var other = pairingOffer; other.eventId = eventB
        let vault = FixtureCredentialVault()
        let pairing = PairingCoordinator(vault: vault, store: store, transport: FixturePairingTransport(offer: other))
        do { try await pairing.begin(address: fixtureAddress, code: "K7QM4TZP", confirmed: other); XCTFail() }
        catch { XCTAssertEqual(error as? CheckInError, .differentEventHasUnsent(count: 1)) }
        XCTAssertNil(try vault.read().pending); XCTAssertEqual(try store.pairing()?.eventId, eventA)
    }

    func testSecureCredentialLengthRandomnessAndKnownSHA256() throws {
        let a = try DeviceCredential.generate(), b = try DeviceCredential.generate()
        XCTAssertNotEqual(a, b); XCTAssertEqual(a.count, 46); XCTAssertTrue(a.hasPrefix("dc_"))
        XCTAssertEqual(DeviceCredential.hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testPrefixSafeURLsAndQRAndRejectAmbiguousOrInsecureAddresses() throws {
        for address in [fixtureAddress, fixtureAddress + "/"] {
            XCTAssertEqual(try ParticipantAddress(address).endpoint("pair").path, "/s/k3v9/device/v1/pair")
        }
        let (address, code) = try ParticipantAddress.pairingQR(fixtureAddress + "/pair#v=1&code=K7QM-4TZP")
        XCTAssertEqual(address.url.absoluteString, fixtureAddress); XCTAssertEqual(code, "K7QM4TZP")
        for bad in ["http://fixture.invalid", "https://user:pass@fixture.invalid", "https://fixture.invalid/a/../b",
                    "https://fixture.invalid/a/%2e%2e/b", "https://fixture.invalid/%2fsecret",
                    "https://fixture.invalid/a?next=b", "https://fixture.invalid/a#code=x"] {
            XCTAssertThrowsError(try ParticipantAddress(bad))
        }
        XCTAssertThrowsError(try ParticipantAddress.pairingQR(fixtureAddress))
        for encodedPrefix in ["https://fixture.invalid/s/%2fhidden", "https://fixture.invalid/s/%252e%252e", "https://fixture.invalid/s/%2e%2e"] {
            XCTAssertThrowsError(try ParticipantAddress.pairingQR(encodedPrefix + "/pair#v=1&code=K7QM4TZP"))
        }
    }

    func testHTTPPairSendsOnlyHashProtocolAndOldProofWithoutBrowserHeaders() async throws {
        let client = CapturingClient(response: NativeResponse(status: 201,
            body: try DeviceProtocol.encode(PairingSuccess(eventId: eventA, deviceId: "dev_fixture", deviceLabel: "iPad 2",
                                                          credentialHash: DeviceCredential.hash(fixtureCredential)))))
        let api = NativeDeviceAPI(client: client)
        _ = try await api.pair(address: ParticipantAddress(fixtureAddress), code: "K7QM4TZP",
                              credentialHash: DeviceCredential.hash(fixtureCredential), oldDeviceProof: "dc_old_fixture")
        let request = await client.requests.first!
        XCTAssertEqual(request.headers["X-Attendance-Device-Protocol"], "1")
        XCTAssertEqual(request.headers["Authorization"], "Bearer dc_old_fixture")
        for header in ["Origin", "Cookie", "Sec-Fetch-Site"] { XCTAssertNil(request.headers[header]) }
        let body = String(decoding: request.body!, as: UTF8.self)
        XCTAssertFalse(body.contains(fixtureCredential)); XCTAssertFalse(body.contains("installId"))
        XCTAssertTrue(DeviceProtocol.privacyViolations(in: request.body!).isEmpty)
        XCTAssertEqual(request.url.path, "/s/k3v9/device/v1/pair")
    }

    func testMalformed401IsAmbiguousWhileGeneric401IsDefinite() async throws {
        let client = CapturingClient(response: NativeResponse(status: 401, body: Data("<html>gateway</html>".utf8)))
        do { _ = try await NativeDeviceAPI(client: client).pair(address: ParticipantAddress(fixtureAddress),
                code: "K7QM4TZP", credentialHash: "hash", oldDeviceProof: nil); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .invalidResponse) }
        await client.setResponse(NativeResponse(status: 401, body: Data("{\"error\":\"invalid_or_expired_code\"}".utf8)))
        do { _ = try await NativeDeviceAPI(client: client).pair(address: ParticipantAddress(fixtureAddress),
                code: "K7QM4TZP", credentialHash: "hash", oldDeviceProof: nil); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .invalidOrExpiredCode) }
    }
}

private actor CapturingClient: NativeHTTPClient {
    var response: NativeResponse
    private(set) var requests: [NativeRequest] = []
    init(response: NativeResponse) { self.response = response }
    func setResponse(_ response: NativeResponse) { self.response = response }
    func send(_ request: NativeRequest) async throws -> NativeResponse { requests.append(request); return response }
}

private final class FailingCredentialVault: CredentialVault, @unchecked Sendable {
    private let lock = NSLock()
    private var state: CredentialState
    private var writes = 0
    private let failWrite: Int
    init(_ state: CredentialState, failWrite: Int) { self.state = state; self.failWrite = failWrite }
    func read() throws -> CredentialState { lock.lock(); defer { lock.unlock() }; return state }
    func write(_ state: CredentialState) throws {
        lock.lock(); defer { lock.unlock() }; writes += 1
        if writes == failWrite { throw PairingError.keychain(-1) }
        self.state = state
    }
}
