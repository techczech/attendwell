import Foundation
import Security
import WorkshopCheckInCore

/// Runs in an iPad Simulator app process. Every item/service/database is
/// fictional and isolated. Writes only boolean results, never secret values.
enum PlatformProbe {
    static func run() async -> Bool {
        var checks: [String: Bool] = [:]
        var stage = "initialise"
        var keychainStatus: Int32?
        var notApplicable: [String: String] = [:]
        do {
            let service = "net.dominiklukes.attendwell.ipad.probe." + UUID().uuidString
            let vault = KeychainCredentialVault(installationID: "fixture-install-a", service: service)
            defer { try? vault.removeItem() }
            let pinService = service + ".pin"
            let pinVault = KeychainPINVault(installationID: "fixture-install-a", service: pinService)
            defer { try? pinVault.writePIN(nil) }
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
                .appendingPathComponent("fictional-platform-probe", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let file = directory.appendingPathComponent("fictional.sqlite")
            let store = try CheckInStore(fileURL: file)
            stage = "pending-keychain-write"
            let offer = PairingOffer(eventId: "evt_probe", eventCode: "7Q2M", eventName: "Fictional Workshop", eventDate: "14 October 2026", deviceLabel: "iPad 2")
            let host = FixturePairingTransport(offer: offer, faults: [.loseReply])
            let first = PairingCoordinator(vault: vault, store: store, transport: host)
            try await first.begin(address: "https://fixture.invalid/s/prefix", code: "K7QM4TZP", confirmed: offer)
            stage = "lost-response"
            do { _ = try await first.retry(); checks["lostReply"] = false }
            catch { checks["lostReply"] = (error as? TransportFailure) == .timedOut }
            let reopened = KeychainCredentialVault(installationID: "fixture-install-a", service: service)
            checks["pendingSurvivesNewInstance"] = try reopened.read().pending != nil && reopened.read().active == nil
            let coordinator = PairingCoordinator(vault: reopened, store: store, transport: host)
            stage = "promotion"
            _ = try await coordinator.retry()
            checks["promotionAfterSuccess"] = try reopened.read().pending == nil && reopened.read().active != nil
            let hashes = await host.submittedHashes
            checks["stableLostResponseHash"] = hashes.count == 2 && hashes.first == hashes.last
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: "device-state",
                kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            let attributes = result as? [String: Any]
            checks["deviceOnlyAfterFirstUnlock"] = status == errSecSuccess &&
                (attributes?[kSecAttrAccessible as String] as? String) == (kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
            checks["notSynchronisable"] = status == errSecSuccess && !(attributes?[kSecAttrSynchronizable as String] as? Bool ?? false)
            let newInstall = KeychainCredentialVault(installationID: "fixture-install-b", service: service)
            checks["staleInstallationCleared"] = try newInstall.read().active == nil
            let pin = OrganiserPIN(vault: pinVault)
            stage = "pin-write"
            try await pin.set("123456", confirmation: "123456")
            try await pin.unlock("123456")
            checks["pinNotPlaintext"] = try pinVault.readPIN()?.hash != "123456"
            for _ in 0..<5 { do { try await pin.unlock("000000") } catch {} }
            let restartedPIN = OrganiserPIN(vault: KeychainPINVault(installationID: "fixture-install-a", service: pinService))
            do { try await restartedPIN.unlock("123456"); checks["pinLockoutPersists"] = false }
            catch { checks["pinLockoutPersists"] = (error as? PINError) == .locked }
            let fileAttributes = try FileManager.default.attributesOfItem(atPath: file.path)
            #if targetEnvironment(simulator)
            // The simulator does not enforce iOS Data Protection; this check runs on a device only.
            notApplicable["fileProtectionMetadata"] = "not-applicable-simulator"
            #else
            checks["fileProtectionMetadata"] = (fileAttributes[.protectionKey] as? FileProtectionType) == .completeUntilFirstUserAuthentication
            #endif
            checks["excludedFromBackupMetadata"] = try file.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
            checks["completed"] = true
        } catch {
            if case PairingError.keychain(let status) = error { keychainStatus = status }
            checks["completed"] = false
        }
        let passed = checks.count == 12 - notApplicable.count && checks.values.allSatisfy { $0 }
        var output: [String: Any] = ["fictional": true, "passed": passed, "checks": checks, "stage": stage]
        if !notApplicable.isEmpty { output["notApplicable"] = notApplicable }
        if let keychainStatus { output["keychainStatus"] = keychainStatus }
        do {
            let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys, .prettyPrinted])
                .write(to: documents.appendingPathComponent("fictional-platform-probe.json"), options: .atomic)
        } catch { return false }
        return passed
    }
}
