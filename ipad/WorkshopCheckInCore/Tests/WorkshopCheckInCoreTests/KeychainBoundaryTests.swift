import Foundation
import XCTest
import Security
import WorkshopCheckInCore

/// Only UUID-scoped fictional test items in the runner's Keychain. Never reads
/// the app's normal service or any existing user credential.
final class KeychainBoundaryTests: XCTestCase {
    func testRealKeychainPersistsActiveAndDoesNotSynchronise() throws {
        let service = "org.workshop-check-in.tests.credentials." + UUID().uuidString
        let first = KeychainCredentialVault(installationID: "fixture-install-a", service: service)
        defer { try? first.removeItem() }
        let offer = PairingOffer(eventId: "evt_fixture", eventCode: "7Q2M", eventName: "Fictional Workshop", eventDate: "14 October 2026", deviceLabel: "iPad 2")
        let active = ActiveCredential(credential: "dc_fixture_only", address: "https://fixture.invalid/s/prefix", offer: offer, deviceId: "dev_fixture")
        try first.write(CredentialState(active: active))
        let second = KeychainCredentialVault(installationID: "fixture-install-a", service: service)
        XCTAssertEqual(try second.read().active, active)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: "device-state",
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        XCTAssertEqual(SecItemCopyMatching(query as CFDictionary, &result), errSecSuccess)
        let attributes = try XCTUnwrap(result as? [String: Any])
        #if os(iOS)
        XCTAssertEqual(attributes[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        #else
        // macOS legacy Keychain omits this iOS-only policy. The REQUIRED
        // simulator platform probe asserts it inside an iPad app process.
        XCTAssertNil(attributes[kSecAttrAccessible as String])
        #endif
        XCTAssertFalse(attributes[kSecAttrSynchronizable as String] as? Bool ?? false)
        // A reinstall cannot silently inherit another installation's credential.
        let reinstall = KeychainCredentialVault(installationID: "fixture-install-b", service: service)
        XCTAssertNil(try reinstall.read().active)
        XCTAssertNil(try first.read().active)
    }

    func testRealKeychainPendingAttemptSurvivesLostReplyAndCoordinatorRelaunch() async throws {
        let service = "org.workshop-check-in.tests.pending." + UUID().uuidString
        let firstVault = KeychainCredentialVault(installationID: "fixture-install-a", service: service)
        defer { try? firstVault.removeItem() }
        let dir = try TempDirectory(); let store = try CheckInStore(fileURL: dir.storeFile, clock: FakeClock())
        let offer = PairingOffer(eventId: eventA, eventCode: "7Q2M", eventName: "Fictional Workshop", eventDate: "14 October 2026", deviceLabel: "iPad 2")
        let host = FixturePairingTransport(offer: offer, faults: [.loseReply])
        let first = PairingCoordinator(vault: firstVault, store: store, transport: host)
        try await first.begin(address: "https://fixture.invalid/s/prefix", code: "K7QM4TZP", confirmed: offer)
        do { _ = try await first.retry(); XCTFail() } catch { XCTAssertEqual(error as? TransportFailure, .timedOut) }
        let newVault = KeychainCredentialVault(installationID: "fixture-install-a", service: service)
        XCTAssertNotNil(try newVault.read().pending); XCTAssertNil(try newVault.read().active)
        let relaunched = PairingCoordinator(vault: newVault, store: store, transport: host)
        _ = try await relaunched.retry()
        XCTAssertNil(try newVault.read().pending); XCTAssertNotNil(try newVault.read().active)
        let hashes = await host.submittedHashes
        XCTAssertEqual(hashes.count, 2); XCTAssertEqual(hashes.first, hashes.last)
    }

    func testRealKeychainPINSurvivesNewInstanceAndHasNoPlaintextPIN() async throws {
        let service = "org.workshop-check-in.tests.pin." + UUID().uuidString
        let vault = KeychainPINVault(installationID: "fixture-install-a", service: service)
        defer { try? vault.writePIN(nil) }
        let clock = FakeClock()
        let first = OrganiserPIN(vault: vault, clock: clock)
        try await first.set("123456", confirmation: "123456")
        let newVault = KeychainPINVault(installationID: "fixture-install-a", service: service)
        XCTAssertNotEqual(try newVault.readPIN()?.hash, "123456")
        let relaunched = OrganiserPIN(vault: newVault, clock: clock)
        try await relaunched.unlock("123456")
        for _ in 0..<5 { do { try await relaunched.unlock("000000"); XCTFail() } catch {} }
        let third = OrganiserPIN(vault: KeychainPINVault(installationID: "fixture-install-a", service: service), clock: clock)
        do { try await third.unlock("123456"); XCTFail() } catch { XCTAssertEqual(error as? PINError, .locked) }
        clock.advance(30); try await third.unlock("123456")
    }
}
