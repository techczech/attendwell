import Foundation
import CryptoKit
import Security

public struct PINState: Codable, Sendable {
    public var salt: String
    public var hash: String
    public var failures: Int = 0
    public var lockedUntil: TimeInterval?
    public var lockBoot: String?
    public init(salt: String, hash: String) { self.salt = salt; self.hash = hash }
}
public protocol PINVault: Sendable {
    func readPIN() throws -> PINState?
    func writePIN(_ state: PINState?) throws
}
public enum PINError: Error, Equatable { case invalidPIN, locked, incorrect, notSet }

public actor OrganiserPIN {
    private let vault: any PINVault
    private let clock: any CheckInClock
    public init(vault: any PINVault, clock: any CheckInClock = SystemClock()) { self.vault = vault; self.clock = clock }
    public func isSet() throws -> Bool { try vault.readPIN() != nil }
    /// UI allows this only in first setup, an unlocked menu, or definite fresh
    /// pairing. A code scan by itself is never an override.
    public func set(_ pin: String, confirmation: String) throws {
        guard pin == confirmation, pin.count == 6, pin.utf8.allSatisfy({ (48...57).contains($0) }) else {
            throw PINError.invalidPIN
        }
        let salt = try DeviceCredential.generate()
        try vault.writePIN(PINState(salt: salt, hash: Self.digest(salt, pin)))
    }
    public func unlock(_ pin: String) throws {
        guard var state = try vault.readPIN() else { throw PINError.notSet }
        if let until = state.lockedUntil {
            // Reboot or unavailable boot identity restarts the full delay,
            // rather than trusting a participant-adjustable wall clock.
            if state.lockBoot != clock.bootID() || state.lockBoot == "unknown" {
                state.lockedUntil = clock.monotonicSeconds() + 30; state.lockBoot = clock.bootID()
                try vault.writePIN(state); throw PINError.locked
            }
            guard clock.monotonicSeconds() >= until else { throw PINError.locked }
            state.lockedUntil = nil; state.failures = 0
        }
        let candidate = Array(Self.digest(state.salt, pin).utf8), expected = Array(state.hash.utf8)
        var diff: UInt8 = 0
        for (a, b) in zip(candidate, expected) { diff |= a ^ b }
        if candidate.count == expected.count, diff == 0 {
            state.failures = 0; state.lockedUntil = nil; try vault.writePIN(state); return
        }
        state.failures += 1
        if state.failures >= 5 { state.lockedUntil = clock.monotonicSeconds() + 30; state.lockBoot = clock.bootID() }
        try vault.writePIN(state)
        throw state.lockedUntil == nil ? PINError.incorrect : PINError.locked
    }
    public func clear() throws { try vault.writePIN(nil) }
    private static func digest(_ salt: String, _ pin: String) -> String { DeviceCredential.hash(salt + ":" + pin) }
}

public final class KeychainPINVault: PINVault, @unchecked Sendable {
    private let installationID: String
    private let service: String
    private let lock = NSLock()
    private struct Envelope: Codable { let installationID: String; let pin: PINState }
    public init(installationID: String, service: String = "org.workshop-check-in.native.pin") {
        self.installationID = installationID; self.service = service
    }
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "organiser-pin", kSecAttrSynchronizable as String: false]
    }
    public func readPIN() throws -> PINState? {
        lock.lock(); defer { lock.unlock() }
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let result = SecItemCopyMatching(q as CFDictionary, &item)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess, let data = item as? Data else { throw PairingError.keychain(result) }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.installationID == installationID else {
            let deletion = SecItemDelete(query as CFDictionary)
            guard deletion == errSecSuccess else { throw PairingError.keychain(deletion) }; return nil
        }
        return envelope.pin
    }
    public func writePIN(_ state: PINState?) throws {
        lock.lock(); defer { lock.unlock() }
        guard let state else {
            let result = SecItemDelete(query as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw PairingError.keychain(result) }; return
        }
        let data = try JSONEncoder().encode(Envelope(installationID: installationID, pin: state))
        let attrs: [String: Any] = [kSecValueData as String: data,
                                  kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var result = SecItemUpdate(query as CFDictionary, attrs as CFDictionary)
        if result == errSecItemNotFound { result = SecItemAdd(query.merging(attrs) { _, new in new } as CFDictionary, nil) }
        guard result == errSecSuccess else { throw PairingError.keychain(result) }
    }
}

public final class FixturePINVault: PINVault, @unchecked Sendable {
    private let lock = NSLock(); private var state: PINState?
    public init() {}
    public func readPIN() throws -> PINState? { lock.lock(); defer { lock.unlock() }; return state }
    public func writePIN(_ state: PINState?) throws { lock.lock(); defer { lock.unlock() }; self.state = state }
}
