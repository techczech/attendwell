import Foundation
import Security

/// Local install marker is supplied by the app's sandbox, never sent to a host.
/// A different installation discards stale Keychain credentials only; the
/// attendance store is never read or removed here.
public final class KeychainCredentialVault: CredentialVault, @unchecked Sendable {
    private struct Envelope: Codable { var installationID: String; var state: CredentialState }
    private let installationID: String
    private let service: String
    private let lock = NSLock()
    public init(installationID: String, service: String = "org.workshop-check-in.native.credentials") {
        self.installationID = installationID; self.service = service
    }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "device-state", kSecAttrSynchronizable as String: false]
    }
    public func read() throws -> CredentialState {
        lock.lock(); defer { lock.unlock() }
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return CredentialState() }
        guard status == errSecSuccess, let data = result as? Data else { throw PairingError.keychain(status) }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.installationID == installationID else {
            let deletion = SecItemDelete(query as CFDictionary)
            guard deletion == errSecSuccess else { throw PairingError.keychain(deletion) }
            return CredentialState()
        }
        return envelope.state
    }
    public func write(_ state: CredentialState) throws {
        lock.lock(); defer { lock.unlock() }
        let data = try JSONEncoder().encode(Envelope(installationID: installationID, state: state))
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attrs) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw PairingError.keychain(status) }
    }
    public func removeItem() throws {
        lock.lock(); defer { lock.unlock() }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PairingError.keychain(status) }
    }
}

/// Explicitly fictional, in-memory store for tests/previews only.
public final class FixtureCredentialVault: CredentialVault, @unchecked Sendable {
    private let lock = NSLock()
    private var state: CredentialState
    public init(_ state: CredentialState = CredentialState()) { self.state = state }
    public func read() throws -> CredentialState { lock.lock(); defer { lock.unlock() }; return state }
    public func write(_ value: CredentialState) throws { lock.lock(); defer { lock.unlock() }; state = value }
}
