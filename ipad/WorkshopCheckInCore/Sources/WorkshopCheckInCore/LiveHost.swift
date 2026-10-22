import Foundation

/// Retries only "no answer" failures (unreachable, timed out) with capped,
/// jittered exponential backoff. A definite answer (revoked, moved, update
/// needed, invalid code, a malformed reply) or a 429 is never retried here.
/// Resending is safe: operations reuse their `opId` and pairing reuses the
/// same code and credential hash (docs/adr/0003 replay window).
public struct RetryPolicy: Sendable {
    public var attempts: Int
    public var baseDelay: TimeInterval
    public var maxDelay: TimeInterval
    public var sleep: @Sendable (TimeInterval) async throws -> Void

    public init(attempts: Int, baseDelay: TimeInterval, maxDelay: TimeInterval,
                sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
                    try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                }) {
        self.attempts = max(1, attempts); self.baseDelay = baseDelay; self.maxDelay = maxDelay; self.sleep = sleep
    }

    /// Three tries, 0.5 s then 1 s (each with up to half again of jitter
    /// removed). Kept short: the Kiosk screen retries every 10 s anyway.
    public static let standard = RetryPolicy(attempts: 3, baseDelay: 0.5, maxDelay: 4)

    public func delay(beforeRetry retry: Int) -> TimeInterval {
        let exponential = min(maxDelay, baseDelay * pow(2, Double(retry - 1)))
        return exponential * Double.random(in: 0.5...1.0)
    }

    public func run<T>(_ body: () async throws -> T) async throws -> T {
        var retry = 0
        while true {
            do { return try await body() }
            catch let failure as TransportFailure where (failure == .unreachable || failure == .timedOut)
                && retry + 1 < attempts {
                retry += 1
                try await sleep(delay(beforeRetry: retry))
            }
        }
    }
}

/// The real laptop host over HTTPS (device protocol v1). Reads the active
/// credential from the vault on every call, so a re-pair to a new address
/// (a restarted quick tunnel) takes effect at once and the outbox, keyed by
/// event, drains to the same event at the new address.
///
/// The bearer is sent only in the `Authorization` header to the address it
/// was paired with; it never appears in a URL, body, error or log.
public struct LiveHostTransport: PairingTransport, DeviceTransport {
    private let vault: any CredentialVault
    private let store: CheckInStore
    private let client: any NativeHTTPClient
    private let retry: RetryPolicy
    private let appVersion: String?
    private let rateLimit: RetryAfterGate

    public init(vault: any CredentialVault, store: CheckInStore,
                client: any NativeHTTPClient = URLSessionNativeClient(), retry: RetryPolicy = .standard,
                appVersion: String? = LiveHostTransport.bundleVersion, rateLimit: RetryAfterGate = RetryAfterGate()) {
        self.vault = vault; self.store = store; self.client = client; self.retry = retry; self.rateLimit = rateLimit
        self.appVersion = appVersion.flatMap { Self.isValidAppVersion($0) ? $0 : nil }
    }

    public static var bundleVersion: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }
    /// The host accepts 1–32 characters of 0–9 A–Z a–z . + -
    static func isValidAppVersion(_ value: String) -> Bool {
        (1...32).contains(value.utf8.count) && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 46 || $0 == 43 || $0 == 45
        }
    }

    public func hello(address: ParticipantAddress, code: String,
                      organiserProof: OrganiserProofRequest?) async throws -> PairingHello {
        try await retry.run {
            try await NativeDeviceAPI(client: client, rateLimit: rateLimit)
                .hello(address: address, code: code, organiserProof: organiserProof)
        }
    }

    public func pair(address: ParticipantAddress, code: String, credentialHash: String,
                     oldDeviceProof: String?) async throws -> PairingSuccess {
        try await retry.run {
            try await NativeDeviceAPI(client: client, rateLimit: rateLimit).pair(address: address, code: code,
                credentialHash: credentialHash, oldDeviceProof: oldDeviceProof)
        }
    }

    /// The full names list for the paired event, refreshed by roster version.
    /// With a cached list, a heartbeat (which also reports the outbox counts
    /// to the organiser) says whether anything changed; the names are fetched
    /// only when its `rosterVersion` differs. An unchanged list comes back
    /// from the cache with the heartbeat's window and server time, so applying
    /// the result never empties the list. The heartbeat's window is saved at
    /// once, so a closed window counts even if fetching the names then fails.
    public func fetchRoster() async throws -> RosterSnapshot {
        let active = try activeCredential()
        let eventId = active.offer.eventId
        let api = NativeDeviceAPI(client: client, active: active, rateLimit: rateLimit)
        if let cached = try store.cachedRoster(eventId: eventId), let version = cached.rosterVersion {
            let report = try store.heartbeatReport(eventId: eventId, appVersion: appVersion)
            let beat = try await retry.run { try await api.heartbeat(report) }
            // `heartbeat` has already checked the event and roster version.
            try store.applyWindow(eventId: eventId, window: beat.window, serverTime: beat.serverTime)
            if beat.rosterVersion == version {
                return RosterSnapshot(eventId: eventId, eventCode: active.offer.eventCode, serverTime: beat.serverTime,
                                      window: beat.window, people: cached.people, rosterVersion: version)
            }
        }
        return try await retry.run { try await api.roster() }
    }

    public func submitOperations(eventId: String, body: Data) async throws -> Data {
        let active = try activeCredential()
        let api = NativeDeviceAPI(client: client, active: active, rateLimit: rateLimit)
        return try await retry.run { try await api.submitOperations(eventId: eventId, body: body) }
    }

    private func activeCredential() throws -> ActiveCredential {
        guard let active = try vault.read().active else { throw TransportFailure.revoked }
        return active
    }
}
