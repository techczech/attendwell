import Foundation

public struct ParticipantAddress: Sendable, Equatable {
    public let url: URL
    public init(_ value: String) throws {
        guard let c = URLComponents(string: value), c.scheme?.lowercased() == "https",
              let host = c.host, !host.isEmpty, c.user == nil, c.password == nil,
              c.query == nil, c.fragment == nil, c.port.map({ (1...65535).contains($0) }) ?? true,
              let u = c.url else { throw PairingError.invalidAddress }
        // Reject ambiguous prefixes instead of letting a proxy normalise them.
        let lower = c.percentEncodedPath.lowercased()
        guard !lower.contains("%2f"), !lower.contains("%5c"), !lower.contains("%25"),
              !lower.contains("\\"), let path = c.percentEncodedPath.removingPercentEncoding,
              !path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
              !path.contains("//"), !value.contains(where: { $0.isWhitespace || $0.isNewline }) else {
            throw PairingError.invalidAddress
        }
        guard let origin = Self.whatwgHost(c.percentEncodedHost ?? host) else { throw PairingError.invalidAddress }
        url = u
        let port = c.port.flatMap { $0 == 443 ? nil : $0 }
        proofOrigin = "https://" + origin + (port.map { ":" + String($0) } ?? "")
    }
    /// The participant origin signed into the organiser proof: the WHATWG
    /// `URL.origin` of the scanned address, as the host computes it with
    /// `new URL(participantOrigin).origin`. `https://`, the host in its
    /// serialised form, `:port` only when the port is not 443 (`:0443` and
    /// `:443` both drop), and never a path or trailing slash.
    public let proofOrigin: String
    /// Hosts whose WHATWG serialisation this code reproduces exactly, so the
    /// signed origin cannot differ from the host's: an ASCII domain (letters,
    /// digits, `-`, `_`, `.`; lower-cased), a canonical dotted-quad IPv4, or a
    /// bracketed IPv6 literal (serialised as WHATWG does: lower-case hex,
    /// longest zero run compressed). Anything else (non-ASCII or
    /// percent-encoded names, shortened or hex IPv4, IPv6 zone ids) is
    /// refused rather than guessed at.
    static func whatwgHost(_ raw: String) -> String? {
        if raw.hasPrefix("[") {
            guard raw.hasSuffix("]"), raw.count > 2 else { return nil }
            return ipv6(String(raw.dropFirst().dropLast()))
        }
        guard !raw.isEmpty, raw.utf8.allSatisfy({
            (97...122).contains($0) || (65...90).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 || $0 == 46
        }) else { return nil }
        let lower = raw.lowercased()
        // WHATWG parses a host whose last label is numeric as IPv4; accept only
        // the canonical form, which it serialises unchanged.
        var labels = lower.split(separator: ".", omittingEmptySubsequences: false)
        if labels.count > 1, labels.last == "" { labels.removeLast() }
        guard let last = labels.last else { return nil }
        let numeric = last.allSatisfy({ ("0"..."9").contains($0) }) || last.hasPrefix("0x")
        guard numeric else { return lower }
        guard labels.count == 4, labels.count == lower.split(separator: ".", omittingEmptySubsequences: false).count,
              labels.allSatisfy({ part in
                  guard !part.isEmpty, part.count <= 3, part.allSatisfy({ ("0"..."9").contains($0) }),
                        part == "0" || !part.hasPrefix("0"), let v = Int(part) else { return false }
                  return v <= 255
              }) else { return nil }
        return lower
    }
    private static func ipv6(_ text: String) -> String? {
        var addr = in6_addr()
        guard !text.contains("%"), text.withCString({ inet_pton(AF_INET6, $0, &addr) }) == 1 else { return nil }
        let bytes = withUnsafeBytes(of: &addr) { Array($0) }
        let pieces = (0..<8).map { UInt16(bytes[2 * $0]) << 8 | UInt16(bytes[2 * $0 + 1]) }
        // Longest run of two or more zero pieces, the first on a tie.
        var best = (start: -1, length: 1), i = 0
        while i < 8 {
            guard pieces[i] == 0 else { i += 1; continue }
            var j = i
            while j < 8, pieces[j] == 0 { j += 1 }
            if j - i > best.length { best = (i, j - i) }
            i = j
        }
        var out = "", index = 0
        while index < 8 {
            if index == best.start {
                out += index == 0 ? "::" : ":"
                index += best.length; continue
            }
            out += String(pieces[index], radix: 16)
            if index < 7 { out += ":" }
            index += 1
        }
        return "[" + out + "]"
    }
    public func endpoint(_ name: String) throws -> URL {
        guard ["hello", "pair", "roster", "operations", "heartbeat"].contains(name) else {
            throw PairingError.invalidAddress
        }
        // appendPathComponent preserves /s/<session>, including trailing slash.
        return url.appendingPathComponent("device").appendingPathComponent("v1").appendingPathComponent(name)
    }
    /// Fictional v1 QR contract, documented in contract/device-v1/pairing.md.
    public static func pairingQR(_ text: String) throws -> (ParticipantAddress, String) {
        guard var c = URLComponents(string: text), c.query == nil,
              c.percentEncodedPath.hasSuffix("/pair"), let fragment = c.fragment,
              let f = URLComponents(string: "https://fixture.invalid/?" + fragment),
              let items = f.queryItems, items.count == 2,
              items.filter({ $0.name == "v" && $0.value == "1" }).count == 1,
              let code = items.first(where: { $0.name == "code" })?.value else {
            throw PairingError.invalidCode
        }
        c.fragment = nil; c.percentEncodedPath = String(c.percentEncodedPath.dropLast(5))
        guard let base = c.url?.absoluteString else { throw PairingError.invalidAddress }
        return (try ParticipantAddress(base), try PairingCoordinator.code(code))
    }
}

public struct NativeRequest: Sendable {
    public let url: URL
    public let method: String
    public let headers: [String: String]
    public let body: Data?
    /// Replies larger than this are refused. The names list may be larger
    /// than the 64 KB request limit; every other reply is small.
    public let maxResponseBytes: Int
    init(url: URL, method: String, headers: [String: String], body: Data?, maxResponseBytes: Int = 65_536) {
        self.url = url; self.method = method; self.headers = headers; self.body = body
        self.maxResponseBytes = maxResponseBytes
    }
}
public struct NativeResponse: Sendable {
    public let status: Int
    public let body: Data
    /// Seconds from a 429's `Retry-After`, if it had a readable one.
    public let retryAfter: TimeInterval?
    public init(status: Int, body: Data, retryAfter: TimeInterval? = nil) {
        self.status = status; self.body = body; self.retryAfter = retryAfter
    }
}

/// Holds the laptop's `Retry-After` per origin. Until the deadline passes,
/// every request to that origin, automatic or a tap on Send now / Try again,
/// is refused on the iPad with `rateLimited` and never reaches the network.
/// Measured on the system uptime clock, so changing the iPad's clock cannot
/// shorten it. Lost on relaunch, when the laptop will answer 429 again if
/// it still needs to.
public final class RetryAfterGate: @unchecked Sendable {
    /// When a 429 has no readable `Retry-After` (the host sends 60).
    public static let defaultDelay: TimeInterval = 60
    /// A bad or hostile header cannot stop sending for longer than this.
    public static let maximumDelay: TimeInterval = 600
    private let lock = NSLock()
    private var deadlines: [String: TimeInterval] = [:]
    private let now: @Sendable () -> TimeInterval
    public init(now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.now = now
    }
    /// Seconds still to wait before this origin may be asked again, if any.
    public func remaining(for url: URL) -> TimeInterval? {
        lock.lock(); defer { lock.unlock() }
        guard let deadline = deadlines[Self.origin(url)] else { return nil }
        let left = deadline - now()
        return left > 0 ? left : nil
    }
    func check(_ url: URL) throws {
        if remaining(for: url) != nil { throw TransportFailure.rateLimited }
    }
    func hold(_ url: URL, retryAfter: TimeInterval?) {
        let delay = min(Self.maximumDelay, max(1, retryAfter ?? Self.defaultDelay))
        lock.lock(); defer { lock.unlock() }
        let key = Self.origin(url), deadline = now() + delay
        deadlines[key] = max(deadlines[key] ?? 0, deadline)
    }
    /// `Retry-After` as delta-seconds (all digits, capped at `maximumDelay`) or an HTTP date.
    public static func parse(_ value: String?, now: Date = Date()) -> TimeInterval? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if value.utf8.allSatisfy({ (48...57).contains($0) }) {
            // Every digit counts (leading zeros included); stops growing at
            // the cap, so no length of digits can overflow.
            var seconds = 0
            for digit in value.utf8 {
                seconds = min(Int(maximumDelay) + 1, seconds * 10 + Int(digit - 48))
            }
            return min(maximumDelay, TimeInterval(seconds))
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE',' dd MMM yyyy HH':'mm':'ss 'GMT'"
        return formatter.date(from: value).map { max(0, $0.timeIntervalSince(now)) }
    }
    private static func origin(_ url: URL) -> String {
        "\(url.scheme?.lowercased() ?? "")://\(url.host?.lowercased() ?? ""):\(url.port ?? 443)"
    }
}
public protocol NativeHTTPClient: Sendable {
    func send(_ request: NativeRequest) async throws -> NativeResponse
}

/// Ephemeral session: no browser cookies, cached roster, credential storage or
/// redirects (including cross-origin redirects that could disclose a bearer).
/// TLS is the system's default evaluation: this class deliberately implements
/// no authentication-challenge delegate method, so no certificate can be
/// trusted that iOS itself would refuse. Nothing here logs a URL, header or body.
public final class URLSessionNativeClient: NSObject, NativeHTTPClient, URLSessionTaskDelegate, @unchecked Sendable {
    private let protocolClasses: [AnyClass]?
    public override init() { protocolClasses = nil; super.init() }
    /// Test seam only: lets a URLProtocol stub answer recorded contract replies.
    init(protocolClasses: [AnyClass]) { self.protocolClasses = protocolClasses; super.init() }
    public func urlSession(_ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    public func send(_ request: NativeRequest) async throws -> NativeResponse {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCache = nil; configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 30
        configuration.waitsForConnectivity = false
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var r = URLRequest(url: request.url, cachePolicy: .reloadIgnoringLocalCacheData)
        r.httpMethod = request.method; r.httpBody = request.body; r.httpShouldHandleCookies = false
        r.allHTTPHeaderFields = request.headers
        do {
            let (data, response) = try await session.data(for: r)
            guard let http = response as? HTTPURLResponse else { throw PairingError.invalidResponse }
            // A quick tunnel whose laptop app has stopped answers with a
            // gateway page (502, 530 …). That is "can't reach the laptop",
            // never a definite answer from it.
            if http.statusCode >= 500 { throw TransportFailure.unreachable }
            if http.statusCode == 429 {
                // Answered without reading the body: only the delay matters.
                return NativeResponse(status: 429, body: Data(),
                                      retryAfter: RetryAfterGate.parse(http.value(forHTTPHeaderField: "Retry-After")))
            }
            guard http.value(forHTTPHeaderField: "Content-Type")?.split(separator: ";").first?
                    .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "application/json",
                  data.count <= request.maxResponseBytes else { throw PairingError.invalidResponse }
            return NativeResponse(status: http.statusCode, body: data)
        } catch let error as URLError {
            throw error.code == .timedOut ? TransportFailure.timedOut : TransportFailure.unreachable
        }
    }
}

/// HTTP adapter is deliberately unused by the fictional demo app until
/// the real host contract is validated.
public struct NativeDeviceAPI: PairingTransport, DeviceTransport {
    private let client: any NativeHTTPClient
    private let active: ActiveCredential?
    private let rateLimit: RetryAfterGate?
    public init(client: any NativeHTTPClient, active: ActiveCredential? = nil, rateLimit: RetryAfterGate? = nil) {
        self.client = client; self.active = active; self.rateLimit = rateLimit
    }
    public func hello(address: ParticipantAddress, code: String,
                      organiserProof: OrganiserProofRequest?) async throws -> PairingHello {
        struct Body: Encodable { let code: String; let organiserProof: OrganiserProofRequest? }
        struct Proof: Decodable { let organiserProof: String? }
        let reply = try await call(address: address, endpoint: "hello",
            body: DeviceProtocol.encode(Body(code: code, organiserProof: organiserProof)), credential: nil, success: 200)
        let offer = try DeviceProtocol.decode(PairingOffer.self, from: reply)
        // A proof nobody asked for is ignored; a malformed one fails verification.
        let proof = organiserProof == nil ? nil : (try? DeviceProtocol.decode(Proof.self, from: reply))?.organiserProof
        return PairingHello(offer: offer, organiserProof: proof)
    }
    public func pair(address: ParticipantAddress, code: String, credentialHash: String,
                     oldDeviceProof: String?) async throws -> PairingSuccess {
        struct Body: Encodable { let code: String; let credentialHash: String }
        return try DeviceProtocol.decode(PairingSuccess.self, from: await call(address: address, endpoint: "pair",
            body: DeviceProtocol.encode(Body(code: code, credentialHash: credentialHash)),
            credential: oldDeviceProof, success: 201))
    }
    public func roster() async throws -> RosterSnapshot {
        guard let active else { throw TransportFailure.revoked }
        let snapshot = try DeviceProtocol.decode(RosterSnapshot.self, from: await call(
            address: ParticipantAddress(active.address), endpoint: "roster", body: nil,
            credential: active.credential, success: 200, maxResponseBytes: Self.rosterLimit))
        guard snapshot.eventId == active.offer.eventId else { throw TransportFailure.eventMoved }
        if let version = snapshot.rosterVersion, !RosterSnapshot.isValidRosterVersion(version) {
            throw PairingError.invalidResponse
        }
        return snapshot
    }
    /// `POST heartbeat`: reports the outbox counts, returns the window,
    /// server time and roster version (to decide whether to fetch names).
    public func heartbeat(_ report: HeartbeatReport) async throws -> HeartbeatReply {
        guard let active else { throw TransportFailure.revoked }
        let reply = try DeviceProtocol.decode(HeartbeatReply.self, from: await call(
            address: ParticipantAddress(active.address), endpoint: "heartbeat", body: DeviceProtocol.encode(report),
            credential: active.credential, success: 200))
        guard reply.eventId == active.offer.eventId else { throw TransportFailure.eventMoved }
        guard RosterSnapshot.isValidRosterVersion(reply.rosterVersion) else { throw PairingError.invalidResponse }
        return reply
    }
    /// The host keeps 500 names under 64 KB; this leaves room for long names.
    static let rosterLimit = 1_048_576
    public func submitOperations(eventId: String, body: Data) async throws -> Data {
        guard let active, active.offer.eventId == eventId else { throw TransportFailure.eventMoved }
        let request = try DeviceProtocol.decode(OperationsRequest.self, from: body)
        guard request.eventId == eventId else { throw TransportFailure.eventMoved }
        return try await call(address: ParticipantAddress(active.address), endpoint: "operations", body: body,
                              credential: active.credential, success: 200)
    }
    private func call(address: ParticipantAddress, endpoint: String, body: Data?, credential: String?,
                      success: Int, maxResponseBytes: Int = 65_536) async throws -> Data {
        guard (body?.count ?? 0) <= 65_536 else { throw PairingError.invalidResponse }
        var headers = ["Accept": "application/json", "Content-Type": "application/json",
                       "X-Attendance-Device-Protocol": "1"]
        if let credential { headers["Authorization"] = "Bearer " + credential }
        let url = try address.endpoint(endpoint)
        try rateLimit?.check(url)
        let response = try await client.send(NativeRequest(url: url,
            method: body == nil ? "GET" : "POST", headers: headers, body: body, maxResponseBytes: maxResponseBytes))
        if response.status == 429 {
            rateLimit?.hold(url, retryAfter: response.retryAfter)
            throw TransportFailure.rateLimited
        }
        guard response.body.count <= maxResponseBytes else { throw PairingError.invalidResponse }
        if response.status == 401 {
            if endpoint == "pair" || endpoint == "hello" {
                // Only this definite, names-only generic error spends the local
                // attempt. A gateway 401/malformed body is ambiguous and retained.
                struct Failure: Decodable { let error: String }
                if let failure = try? DeviceProtocol.decode(Failure.self, from: response.body),
                   failure.error == "invalid_or_expired_code" { throw PairingError.invalidOrExpiredCode }
                throw PairingError.invalidResponse
            }
            throw TransportFailure.revoked
        }
        if response.status == 409 { throw TransportFailure.eventMoved }
        if response.status == 426 { throw TransportFailure.updateNeeded }
        guard response.status == success else { throw PairingError.invalidResponse }
        return response.body
    }
}
