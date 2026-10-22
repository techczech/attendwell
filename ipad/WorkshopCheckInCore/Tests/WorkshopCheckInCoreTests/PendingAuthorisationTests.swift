import Foundation
import XCTest
import WorkshopCheckInCore
import WorkshopCheckInUI

private let offer = PairingOffer(eventId: eventA, eventCode: "7Q2M", eventName: "Spring Workshop",
                                 eventDate: "14 October 2026", deviceLabel: "iPad 2")
private let newCredential = "dc_" + String(repeating: "b", count: 43)
private let address = "https://checkin.example.org/s/k3v9"
private let old = ActiveCredential(credential: "dc_old_fixture", address: address, offer: offer, deviceId: "dev_old")

/// A saved pairing attempt replaces the current pairing only with a recorded
/// authorisation: the PIN, or the laptop's proof for this device.
@MainActor
final class PendingAuthorisationTests: XCTestCase {
    /// How the `authorisation` value of a saved attempt is rewritten on disk.
    /// `nil` removes it, as an attempt saved before the field existed.
    private static let unauthorisedRecords: [(String, Any?)] = [
        ("missing (older build)", nil),
        ("first pairing", ["firstPairing": [String: String]()]),
        ("unrecorded", ["unrecorded": [String: String]()]),
        ("unknown value", ["somethingNew": [String: String]()]),
        ("not an object", "organiserPIN"),
        ("proof for another device", ["organiserProof": ["deviceId": "dev_someone_else"]]),
        ("proof with empty device", ["organiserProof": ["deviceId": ""]]),
    ]

    func testAttemptWithoutRecordedAuthorityNeverReplacesTheActivePairing() async throws {
        for definite in [false, true] {
            for (label, record) in Self.unauthorisedRecords {
                let rig = try await savedAttempt(definite: definite, over: old)
                try rewrite(rig.vault, authorisation: record)
                let hashesBefore = await rig.host.submittedHashes.count
                let relaunched = PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.host)
                do { _ = try await relaunched.retry(); XCTFail("\(label), definite \(definite): promoted") }
                catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired, label) }
                XCTAssertEqual(try rig.vault.read(), CredentialState(active: old), "\(label): only the attempt is dropped")
                let hashesAfter = await rig.host.submittedHashes.count
                XCTAssertEqual(hashesAfter, hashesBefore, "\(label): no pair request")
                XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 1, label)
                do { _ = try await relaunched.retry(); XCTFail() }
                catch { XCTAssertEqual(error as? PairingError, .noPendingAttempt, label) }
            }
        }
    }

    /// Without the PIN, a discarded attempt does not open a way round it;
    /// with the PIN, the organiser can pair again at once.
    func testDiscardOnLoadBeforeANewCode() async throws {
        let rig = try await savedAttempt(definite: true, over: old)
        try rewrite(rig.vault, authorisation: nil)
        let coordinator = PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.host,
                                             generate: { newCredential })
        do { _ = try await coordinator.inspect(address: address, code: "K7QM4TZP"); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        XCTAssertEqual(try rig.vault.read(), CredentialState(active: old))
        do { try await coordinator.begin(address: address, code: "K7QM4TZP", confirmed: offer); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        XCTAssertEqual(try rig.vault.read(), CredentialState(active: old))

        let fresh = try await savedAttempt(definite: true, over: old)
        try rewrite(fresh.vault, authorisation: nil)
        let organiser = PairingCoordinator(vault: fresh.vault, store: fresh.store, transport: fresh.host,
                                           generate: { newCredential })
        let inspected = try await organiser.inspect(address: address, code: "K7QM4TZP", authority: .organiserPIN)
        XCTAssertEqual(inspected, offer)
        XCTAssertEqual(try fresh.vault.read(), CredentialState(active: old))
    }

    func testRecordedAuthorityRoundTripsAndPromotes() async throws {
        let rig = try await savedAttempt(definite: true, over: old)
        XCTAssertEqual(try rig.vault.read().pending?.authorisation, .organiserPIN)
        try rewrite(rig.vault, authorisation: nil, keep: true)   // re-encode through JSON only
        let active = try await PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.host).retry()
        XCTAssertEqual(active.credential, newCredential); XCTAssertNil(try rig.vault.read().pending)

        // Proof for this pairing's own device survives a relaunch and promotes.
        let proof = try await savedAttempt(definite: true, over: old)
        try rewrite(proof.vault, authorisation: ["organiserProof": ["deviceId": old.deviceId]])
        XCTAssertEqual(try proof.vault.read().pending?.authorisation, .organiserProof(deviceId: old.deviceId))
        let promoted = try await PairingCoordinator(vault: proof.vault, store: proof.store, transport: proof.host).retry()
        XCTAssertEqual(promoted.credential, newCredential)
    }

    func testFirstPairingIsUnaffectedEvenWithoutARecord() async throws {
        for definite in [false, true] {
            let rig = try await savedAttempt(definite: definite, over: nil)
            XCTAssertEqual(try rig.vault.read().pending?.authorisation, .firstPairing)
            try rewrite(rig.vault, authorisation: nil)
            let active = try await PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.host).retry()
            XCTAssertEqual(active.credential, newCredential)
            XCTAssertNil(try rig.vault.read().pending)
        }
    }

    /// The kiosk shows the saved attempt; retrying it asks for the PIN and
    /// leaves the iPad paired as before.
    func testKioskAsksForThePINWhenTheSavedAttemptIsDiscarded() async throws {
        let rig = try await savedAttempt(definite: true, over: old)
        try rewrite(rig.vault, authorisation: nil)
        let clock = FakeClock()
        let pin = OrganiserPIN(vault: FixturePINVault(), clock: clock); try await pin.set("123456", confirmation: "123456")
        let model = KioskModel(store: rig.store, credentials: rig.vault,
            pairing: PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.host), pin: pin,
            transport: FictionalKioskTransport(host: makeHost(clock: clock), mode: .offline))
        await model.start()
        XCTAssertEqual(model.screen, .pairingUnavailable)
        await model.retryPairing()
        XCTAssertEqual(model.screen, .pin)
        XCTAssertEqual(try rig.vault.read(), CredentialState(active: old))
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 1)
    }

    // MARK: - Rig

    private struct Rig { let store: CheckInStore; let vault: JSONCredentialVault; let host: FixturePairingTransport; let dir: TempDirectory }

    /// A PIN-authorised (or first) attempt saved through the real coordinator:
    /// either left without an answer, or holding a definite success whose
    /// promotion write failed.
    private func savedAttempt(definite: Bool, over active: ActiveCredential?) async throws -> Rig {
        let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: address)
        _ = try store.recordCheckIn(eventId: eventA, personToken: alex.personToken)
        let vault = JSONCredentialVault(CredentialState(active: active))
        let host = FixturePairingTransport(offer: offer, faults: definite ? [] : [.loseReply])
        let pairing = PairingCoordinator(vault: vault, store: store, transport: host, generate: { newCredential })
        try await pairing.begin(address: address, code: "K7QM4TZP", confirmed: offer,
                                authority: active == nil ? .unverified : .organiserPIN)
        if definite { vault.failNextWrite(after: 1) }
        do { _ = try await pairing.retry(); XCTFail("attempt should stay saved") } catch {}
        XCTAssertEqual(try vault.read().pending?.definiteSuccess != nil, definite)
        XCTAssertEqual(try vault.read().active, active)
        return Rig(store: store, vault: vault, host: host, dir: dir)
    }

    /// Rewrites the saved attempt's `authorisation` in the stored JSON.
    private func rewrite(_ vault: JSONCredentialVault, authorisation: Any?, keep: Bool = false) throws {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: vault.data) as? [String: Any])
        var pending = try XCTUnwrap(root["pending"] as? [String: Any])
        if !keep { pending["authorisation"] = authorisation }
        root["pending"] = pending
        vault.data = try JSONSerialization.data(withJSONObject: root)
    }
}

/// Keeps the state as JSON, as the Keychain item does, so every read decodes
/// what a relaunch would.
private final class JSONCredentialVault: CredentialVault, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Data
    private var failAfter: Int?
    init(_ state: CredentialState) { stored = try! JSONEncoder().encode(state) }
    var data: Data {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
    /// Lets `writes` more writes through, then fails the next one.
    func failNextWrite(after writes: Int) { lock.lock(); defer { lock.unlock() }; failAfter = writes }
    func read() throws -> CredentialState { try JSONDecoder().decode(CredentialState.self, from: data) }
    func write(_ state: CredentialState) throws {
        lock.lock(); defer { lock.unlock() }
        if let n = failAfter {
            if n == 0 { failAfter = nil; throw PairingError.keychain(-1) }
            failAfter = n - 1
        }
        stored = try JSONEncoder().encode(state)
    }
}
