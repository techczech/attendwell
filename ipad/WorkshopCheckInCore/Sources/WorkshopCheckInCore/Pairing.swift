import Foundation
import CryptoKit
import Security

// PROVISIONAL native contract: no real laptop endpoints have been validated.
public struct PairingOffer: Codable, Sendable, Equatable {
    public var eventId: String
    public var eventCode: String
    public var eventName: String
    public var eventDate: String
    public var deviceLabel: String
    public init(eventId: String, eventCode: String, eventName: String, eventDate: String, deviceLabel: String) {
        self.eventId = eventId; self.eventCode = eventCode; self.eventName = eventName
        self.eventDate = eventDate; self.deviceLabel = deviceLabel
    }
}

public struct PairingSuccess: Codable, Sendable, Equatable {
    public var eventId: String
    public var deviceId: String
    public var deviceLabel: String
    public var credentialHash: String
    /// `opk_` key the laptop derives for this device. Kept on the iPad only
    /// (Keychain) so a later forgotten-PIN pairing can check that a new QR
    /// really comes from the laptop this iPad was paired with.
    public var organiserProofKey: String?
    public init(eventId: String, deviceId: String, deviceLabel: String, credentialHash: String,
                organiserProofKey: String? = nil) {
        self.eventId = eventId; self.deviceId = deviceId; self.deviceLabel = deviceLabel
        self.credentialHash = credentialHash; self.organiserProofKey = organiserProofKey
    }
}

public struct ActiveCredential: Codable, Sendable, Equatable {
    public var credential: String
    public var address: String
    public var offer: PairingOffer
    public var deviceId: String
    /// Absent for a pairing made before the laptop issued proof keys: then
    /// only the organiser PIN can replace this pairing.
    public var organiserProofKey: String?
    public init(credential: String, address: String, offer: PairingOffer, deviceId: String,
                organiserProofKey: String? = nil) {
        self.credential = credential; self.address = address; self.offer = offer; self.deviceId = deviceId
        self.organiserProofKey = organiserProofKey
    }
}

public struct PendingCredential: Codable, Sendable, Equatable {
    public var credential: String
    public var address: String
    public var code: String
    public var offer: PairingOffer
    // Retained across a lost response; never inferred from install identity.
    public var oldDeviceProof: String?
    public var definiteSuccess: PairingSuccess?
    /// How this attempt was allowed. While the iPad has a current pairing,
    /// only `.organiserPIN` or `.organiserProof` for that pairing's device
    /// may replace it; any other attempt is discarded unpromoted.
    public var authorisation: PendingAuthorisation
}

/// Recorded with every saved pairing attempt, so a retry or relaunch never
/// has to guess who allowed it.
public enum PendingAuthorisation: Codable, Sendable, Equatable {
    /// The iPad had no current pairing when the attempt began.
    case firstPairing
    /// The organiser unlocked this iPad with its PIN.
    case organiserPIN
    /// Forgotten PIN: only the laptop's proof for this device allowed it.
    /// The pair reply must name this same device.
    case organiserProof(deviceId: String)
    /// Saved without a readable record (an older build, or a damaged or
    /// unknown value). Never replaces a current pairing.
    case unrecorded
}

extension PendingCredential {
    private enum CodingKeys: String, CodingKey {
        case credential, address, code, offer, oldDeviceProof, definiteSuccess, authorisation
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        credential = try c.decode(String.self, forKey: .credential)
        address = try c.decode(String.self, forKey: .address)
        code = try c.decode(String.self, forKey: .code)
        offer = try c.decode(PairingOffer.self, forKey: .offer)
        oldDeviceProof = try c.decodeIfPresent(String.self, forKey: .oldDeviceProof)
        definiteSuccess = try c.decodeIfPresent(PairingSuccess.self, forKey: .definiteSuccess)
        // A missing or unreadable record must not stop the vault loading
        // (the current pairing lives in the same item); it reads as
        // `.unrecorded`, which the coordinator discards before promotion.
        authorisation = (try? c.decodeIfPresent(PendingAuthorisation.self, forKey: .authorisation)) ?? .unrecorded
    }

    /// Whether this attempt may become the active pairing over `active`.
    /// A first pairing (no active pairing) is never restricted here.
    public func mayReplace(_ active: ActiveCredential?) -> Bool {
        guard let active else { return true }
        switch authorisation {
        case .organiserPIN: return true
        case .organiserProof(let deviceId): return !deviceId.isEmpty && deviceId == active.deviceId
        case .firstPairing, .unrecorded: return false
        }
    }
}

public struct CredentialState: Codable, Sendable, Equatable {
    public var active: ActiveCredential?
    public var pending: PendingCredential?
    public init(active: ActiveCredential? = nil, pending: PendingCredential? = nil) {
        self.active = active; self.pending = pending
    }
}

/// Each write replaces one atomic Keychain item; promotion cannot delete the
/// old item and then lose the new credential. Secrets never enter SQLite.
public protocol CredentialVault: Sendable {
    func read() throws -> CredentialState
    func write(_ state: CredentialState) throws
}

public enum PairingError: Error, Equatable {
    case invalidAddress, invalidCode, invalidResponse, invalidOrExpiredCode
    case pendingAttemptExists, noPendingAttempt, busy, keychain(Int32), randomFailure
    /// Replacing the current pairing needs the organiser PIN or proof from
    /// the laptop this iPad was paired with; neither was given.
    case organiserAuthorityRequired
}

/// Who is asking to replace the iPad's current pairing.
public enum PairingAuthority: Sendable, Equatable {
    /// Nobody proven: the forgotten-PIN route, reachable by anyone at the
    /// kiosk. Replacing a current pairing needs the laptop's organiser proof.
    case unverified
    /// The organiser unlocked this iPad with its PIN for this pairing.
    case organiserPIN
}

/// Sent in `hello` when the iPad needs the laptop to prove it is the one
/// this iPad was paired with. Neither field is a secret.
public struct OrganiserProofRequest: Codable, Sendable, Equatable {
    public var deviceId: String
    public var nonce: String
    public init(deviceId: String, nonce: String) { self.deviceId = deviceId; self.nonce = nonce }
}

/// A `hello` reply: the offer, plus the organiser proof when one was asked for.
public struct PairingHello: Sendable, Equatable {
    public var offer: PairingOffer
    public var organiserProof: String?
    public init(offer: PairingOffer, organiserProof: String? = nil) {
        self.offer = offer; self.organiserProof = organiserProof
    }
}

/// HMAC-SHA256 proof that a host holds the organiser-proof key it issued to
/// this device at pairing. A stranger's server cannot compute it.
public enum OrganiserProof {
    public static let keyPrefix = "opk_"
    static let label = "attendwell-organiser-proof-v1"

    /// `opk_` + 43 base64url characters (32 bytes, unpadded).
    public static func isValidKey(_ key: String) -> Bool {
        key.hasPrefix(keyPrefix) && key.utf8.count == 47 && key.utf8.dropFirst(4).allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }
    /// 32 random bytes as 64 lowercase hex characters.
    public static func nonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw PairingError.randomFailure
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    /// The signed text: label, device, offered event, code, nonce and the
    /// participant origin the iPad is talking to, one per line (LF, no
    /// trailing LF). The origin binds the proof to that address, so a proof
    /// the real laptop made for its own address cannot be relayed through a
    /// different QR address.
    public static func message(deviceId: String, eventId: String, code: String, nonce: String,
                               origin: String) -> Data {
        Data([label, deviceId, eventId, code, nonce, origin].joined(separator: "\n").utf8)
    }
    /// Lowercase hex HMAC-SHA256 keyed by the UTF-8 bytes of the whole `opk_` key.
    public static func sign(key: String, deviceId: String, eventId: String, code: String, nonce: String,
                            origin: String) -> String {
        Data(HMAC<SHA256>.authenticationCode(
            for: message(deviceId: deviceId, eventId: eventId, code: code, nonce: nonce, origin: origin),
            using: SymmetricKey(data: Data(key.utf8))))
            .map { String(format: "%02x", $0) }.joined()
    }
    /// Constant-time check of a host's proof.
    public static func verify(_ proof: String, key: String, deviceId: String, eventId: String,
                              code: String, nonce: String, origin: String) -> Bool {
        guard isValidKey(key), proof.utf8.count == 64,
              let mac = hexBytes(proof) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(mac,
            authenticating: message(deviceId: deviceId, eventId: eventId, code: code, nonce: nonce, origin: origin),
            using: SymmetricKey(data: Data(key.utf8)))
    }
    private static func hexBytes(_ text: String) -> Data? {
        var out = Data(), high: UInt8?
        for c in text.utf8 {
            let v: UInt8
            switch c { case 48...57: v = c - 48; case 97...102: v = c - 87; default: return nil }
            if let h = high { out.append(h << 4 | v); high = nil } else { high = v }
        }
        return out
    }
}

public enum DeviceCredential {
    public static func generate() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw PairingError.randomFailure
        }
        return "dc_" + Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    public static func hash(_ credential: String) -> String {
        SHA256.hash(data: Data(credential.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public protocol PairingTransport: Sendable {
    /// With `organiserProof`, the host is asked to prove it issued this
    /// device's organiser-proof key; a host that cannot omits the proof.
    func hello(address: ParticipantAddress, code: String,
               organiserProof: OrganiserProofRequest?) async throws -> PairingHello
    func pair(address: ParticipantAddress, code: String, credentialHash: String,
              oldDeviceProof: String?) async throws -> PairingSuccess
}

public actor PairingCoordinator {
    private let vault: any CredentialVault
    private let store: CheckInStore
    private let transport: any PairingTransport
    private let generate: @Sendable () throws -> String
    private var busy = false
    /// The last offer whose host proved it is this iPad's laptop. Only that
    /// address, code and offer may replace the pairing without the PIN.
    private var proven: (endpoint: URL, code: String, offer: PairingOffer, deviceId: String)?
    public init(vault: any CredentialVault, store: CheckInStore, transport: any PairingTransport,
                generate: @escaping @Sendable () throws -> String = { try DeviceCredential.generate() }) {
        self.vault = vault; self.store = store; self.transport = transport; self.generate = generate
    }

    /// Asks the host which event and label this code pairs. While the iPad
    /// has a current pairing, replacing it needs organiser authority: the
    /// PIN, or (forgotten PIN) the laptop's proof that it issued this
    /// device's organiser-proof key. A saved attempt without a definite
    /// answer may be superseded under the same authority; its check-ins and
    /// the current credential are untouched until a new attempt succeeds.
    public func inspect(address: String, code: String,
                        authority: PairingAuthority = .unverified) async throws -> PairingOffer {
        guard !busy else { throw PairingError.busy }
        busy = true; defer { busy = false }
        proven = nil
        let state = try load().state
        if let pending = state.pending, pending.definiteSuccess != nil { throw PairingError.pendingAttemptExists }
        let base = try ParticipantAddress(address), code = try Self.code(code)
        guard let active = state.active, authority != .organiserPIN else {
            let hello = try await transport.hello(address: base, code: code, organiserProof: nil)
            try validate(hello.offer)
            try store.validatePairing(eventId: hello.offer.eventId)
            return hello.offer
        }
        // No PIN: only the laptop that issued this device's key can vouch.
        // Without a key nothing is sent anywhere.
        guard let key = active.organiserProofKey, OrganiserProof.isValidKey(key) else {
            throw PairingError.organiserAuthorityRequired
        }
        let request = OrganiserProofRequest(deviceId: active.deviceId, nonce: try OrganiserProof.nonce())
        let hello = try await transport.hello(address: base, code: code, organiserProof: request)
        try validate(hello.offer)
        // The origin is the address this iPad actually asked, never one the
        // reply names: a proof relayed from the real laptop through another
        // QR address was made for the laptop's origin and fails here.
        guard let proof = hello.organiserProof,
              OrganiserProof.verify(proof, key: key, deviceId: active.deviceId, eventId: hello.offer.eventId,
                                    code: code, nonce: request.nonce, origin: base.proofOrigin) else {
            throw PairingError.organiserAuthorityRequired
        }
        try store.validatePairing(eventId: hello.offer.eventId)
        proven = (try base.endpoint("pair"), code, hello.offer, active.deviceId)
        return hello.offer
    }

    /// Call only after the organiser confirms the event from inspect(), with
    /// the same authority. Saves the new attempt in one write, replacing a
    /// superseded attempt; the active credential stays until promotion.
    public func begin(address: String, code: String, confirmed offer: PairingOffer,
                      useOldDeviceProof: Bool = true, authority: PairingAuthority = .unverified) throws {
        guard !busy else { throw PairingError.busy }
        var state = try load().state
        let base = try ParticipantAddress(address), normalised = try Self.code(code)
        let pairURL = try base.endpoint("pair")
        let wasProven = proven.map {
            $0.endpoint == pairURL && $0.code == normalised && $0.offer == offer && $0.deviceId == state.active?.deviceId
        } ?? false
        proven = nil
        let authorised = state.active == nil || authority == .organiserPIN || wasProven
        if let pending = state.pending {
            guard pending.definiteSuccess == nil, authorised else { throw PairingError.pendingAttemptExists }
        }
        guard authorised else { throw PairingError.organiserAuthorityRequired }
        let authorisation: PendingAuthorisation = state.active.map {
            authority == .organiserPIN ? .organiserPIN : .organiserProof(deviceId: $0.deviceId)
        } ?? .firstPairing
        try validate(offer)
        try store.validatePairing(eventId: offer.eventId)
        let credential = try generate()
        guard credential.hasPrefix("dc_"), credential.count == 46 else { throw PairingError.randomFailure }
        // A QR may name a different host or session prefix. Never disclose
        // the current bearer there: use targeted Pair again on the laptop.
        let sameEndpoint = try state.active.map {
            try ParticipantAddress($0.address).endpoint("pair") == base.endpoint("pair")
        } ?? false
        // Save BEFORE any pair request. A crash/relaunch retries this exact tuple.
        state.pending = PendingCredential(credential: credential, address: base.url.absoluteString,
                                          code: normalised, offer: offer,
                                          oldDeviceProof: useOldDeviceProof && sameEndpoint ? state.active?.credential : nil,
                                          definiteSuccess: nil, authorisation: authorisation)
        try vault.write(state)
    }

    public func retry() async throws -> ActiveCredential {
        guard !busy else { throw PairingError.busy }
        busy = true; defer { busy = false }
        let loaded = try load()
        // An attempt with no recorded authority to replace this pairing was
        // just dropped: nothing is promoted and the organiser PIN is needed.
        if loaded.discarded { throw PairingError.organiserAuthorityRequired }
        var state = loaded.state
        guard var pending = state.pending else { throw PairingError.noPendingAttempt }
        try store.validatePairing(eventId: pending.offer.eventId)
        if pending.definiteSuccess == nil {
            do {
                let success = try await transport.pair(address: ParticipantAddress(pending.address),
                    code: pending.code, credentialHash: DeviceCredential.hash(pending.credential),
                    oldDeviceProof: pending.oldDeviceProof)
                // Forgotten PIN: the laptop vouched for this device only. A
                // reply naming any other device is refused; the attempt is
                // dropped so the vault is as before it, and the PIN is needed.
                if case .organiserProof(let required) = pending.authorisation, success.deviceId != required {
                    state.pending = nil
                    try vault.write(state)
                    throw PairingError.organiserAuthorityRequired
                }
                guard success.eventId == pending.offer.eventId, !success.deviceId.isEmpty,
                      success.deviceLabel == pending.offer.deviceLabel,
                      success.credentialHash == DeviceCredential.hash(pending.credential),
                      success.organiserProofKey.map(OrganiserProof.isValidKey) ?? true else {
                    throw PairingError.invalidResponse
                }
                _ = try DeviceProtocol.encode(success)
                pending.definiteSuccess = success
                state.pending = pending
                // Persist definite success so a local failure doesn't re-spend
                // the code or rely on the host's 15-minute replay window.
                try vault.write(state)
            } catch PairingError.invalidOrExpiredCode {
                state.pending = nil
                try vault.write(state)
                throw PairingError.invalidOrExpiredCode
            }
        }
        guard let success = pending.definiteSuccess else { throw PairingError.invalidResponse }
        try store.setPairing(eventId: pending.offer.eventId, participantAddress: pending.address)
        // The key comes only from this pairing's own reply, never carried over.
        let active = ActiveCredential(credential: pending.credential, address: pending.address,
                                      offer: pending.offer, deviceId: success.deviceId,
                                      organiserProofKey: success.organiserProofKey)
        state.active = active; state.pending = nil
        try vault.write(state)
        return active
    }

    public func state() throws -> CredentialState { try load().state }

    /// Reads the vault and discards a saved attempt that has no authority to
    /// replace the current pairing (see `PendingCredential.mayReplace`), even
    /// one already holding a definite success. The active pairing and the
    /// store's queued check-ins are left as they are.
    private func load() throws -> (state: CredentialState, discarded: Bool) {
        var state = try vault.read()
        guard let pending = state.pending, !pending.mayReplace(state.active) else { return (state, false) }
        state.pending = nil
        try vault.write(state)
        return (state, true)
    }
    private func validate(_ offer: PairingOffer) throws {
        _ = try DeviceProtocol.encode(offer)
        guard !offer.eventId.isEmpty, offer.eventCode.count == 4,
              !offer.deviceLabel.isEmpty, !offer.eventName.isEmpty else { throw PairingError.invalidResponse }
    }
    public static func code(_ value: String) throws -> String {
        let code = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            .replacingOccurrences(of: "-", with: "")
        guard (8...128).contains(code.count), code.utf8.allSatisfy({
            (65...90).contains($0) || (48...57).contains($0)
        }) else { throw PairingError.invalidCode }
        return code
    }
}

extension CheckInStore {
    /// Read-only preflight; unlike setPairing this never changes the address.
    public func validatePairing(eventId: String) throws {
        try locked {
            let current = try db.query("SELECT event_id FROM pairing WHERE singleton = 1", [], { $0.text(0) }).first
            if let current,
               current != eventId {
                let count = try uncoveredPendingCount(eventId: current)
                if count > 0 { throw CheckInError.differentEventHasUnsent(count: count) }
            }
        }
    }
}
