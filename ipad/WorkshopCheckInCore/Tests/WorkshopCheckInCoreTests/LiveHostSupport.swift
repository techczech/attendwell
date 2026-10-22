import CryptoKit
import Foundation
import XCTest
@testable import WorkshopCheckInCore

// A fictional laptop behind a URLProtocol stub. Replies start from the
// recorded contract fixtures in contract/device-v1/ and follow docs/adr/0003
// pairing rules and docs/adr/0004 idempotency. Nothing listens on a socket.

let contractDirectory: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<4 { url.deleteLastPathComponent() }
    return url.appendingPathComponent("contract/device-v1", isDirectory: true)
}()

func contractFixture(_ name: String) throws -> Data {
    try Data(contentsOf: contractDirectory.appendingPathComponent(name))
}

final class StubLaptop: @unchecked Sendable {
    struct Seen { let url: URL; let method: String; let headers: [String: String]; let body: Data? }
    enum Reply { case json(Int, Data), html(Int), noConnection, rateLimited(retryAfter: String?) }

    private let lock = NSLock()
    // Hosts that currently reach this laptop (a quick tunnel changes on restart).
    private var origins: Set<String>
    private var seenRequests: [Seen] = []
    private var scripted: [Reply] = []
    private var serverTick: TimeInterval = 0

    // Pairing session (ADR-0003).
    private var code = "K7QM4TZP"
    private var codeExpired = false
    private var wrongTries = 0
    private var target: String?
    private var spent: (hash: String, deviceId: String)?
    private var devices: [String: String] = [:]  // deviceId → credential hash
    private var nextDevice = 2
    // Organiser-proof keys are derived from this laptop's own secret, so a
    // restarted tunnel (same laptop) can still prove itself; another server cannot.
    private let secret = SymmetricKey(size: .bits256)
    private var issuesProofKeys = true
    private var relay: (StubLaptop, String)?

    // Event state.
    private let offer: PairingOffer
    private var people: [RosterPerson]
    private var window: WindowInfo
    private var version = 1
    private(set) var lastHeartbeat: HeartbeatReport?
    private var outcomes: [String: OperationOutcome] = [:]
    private(set) var appliedOperations: [WireOperation] = []

    init(origin: String) throws {
        origins = [origin]
        offer = try DeviceProtocol.decode(PairingOffer.self, from: contractFixture("pairing-offer.example.json"))
        let roster = try DeviceProtocol.decode(RosterSnapshot.self, from: contractFixture("roster.example.json"))
        people = roster.people; window = roster.window
    }

    func sync<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

    var requests: [Seen] { sync { seenRequests } }
    var deviceCount: Int { sync { devices.count } }
    var applied: [WireOperation] { sync { appliedOperations } }
    var paths: [String] { requests.map(\.url.path) }
    var heartbeat: HeartbeatReport? { sync { lastHeartbeat } }
    var rosterVersion: String { sync { currentVersion } }
    private var currentVersion: String { String(format: "rv_%016x", version) }

    /// The desktop app restarted: a new quick-tunnel address, the old one gone.
    func moveTunnel(to origin: String) { sync { origins = [origin] } }
    func addOrigin(_ origin: String) { sync { _ = origins.insert(origin) } }
    func goOffline() { sync { origins = [] } }
    func script(_ replies: [Reply]) { sync { scripted = replies } }
    func expireCode() { sync { codeExpired = true } }
    /// Someone else's server that forwards every `hello` to the real laptop.
    func relayHello(to laptop: StubLaptop, at address: String) { sync { relay = (laptop, address) } }
    /// A laptop that does not yet issue organiser-proof keys or proofs.
    func stopIssuingProofKeys() { sync { issuesProofKeys = false } }
    func proofKey(for deviceId: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(("organiser-proof-key:" + deviceId).utf8), using: secret)
        return "opk_" + Data(mac).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    /// Organiser shows a fresh code; with a device id this is "Pair again".
    func newPairingCode(_ value: String, pairAgain deviceId: String? = nil) {
        sync { code = value; codeExpired = false; wrongTries = 0; spent = nil; target = deviceId }
    }
    func rename(_ token: String, to name: String) {
        sync {
            guard let index = people.firstIndex(where: { $0.personToken == token }) else { return }
            people[index].displayName = name; people[index].revision += 1; version += 1
        }
    }
    func closeWindow() {
        sync { window = WindowInfo(state: .closed, revision: window.revision + 1, openedAt: window.openedAt,
                                   closesAt: window.closesAt); version += 1 }
    }

    func handle(_ request: URLRequest) -> Reply {
        sync {
            var body = request.httpBody
            if body == nil, let stream = request.httpBodyStream { body = Self.read(stream) }
            let url = request.url!
            seenRequests.append(Seen(url: url, method: request.httpMethod ?? "GET",
                                     headers: request.allHTTPHeaderFields ?? [:], body: body))
            guard origins.contains(url.host ?? "") else { return .noConnection }
            if !scripted.isEmpty { return scripted.removeFirst() }
            serverTick += 1
            let bearer = request.value(forHTTPHeaderField: "Authorization")
                .flatMap { $0.hasPrefix("Bearer ") ? String($0.dropFirst(7)) : nil }
            switch url.lastPathComponent {
            case "hello": return hello(body, url: url)
            case "pair": return pair(body, bearer: bearer)
            case "roster": return roster(bearer: bearer)
            case "heartbeat": return heartbeat(body, bearer: bearer)
            case "operations": return operations(body, bearer: bearer)
            default: return .json(404, Data(#"{"error":"not_found"}"#.utf8))
            }
        }
    }

    private var serverTime: Date { isoDate("2026-10-14T09:00:00Z") + serverTick }
    private static let invalid = Reply.json(401, Data(#"{"error":"invalid_or_expired_code"}"#.utf8))

    private func codeAccepted(_ submitted: String) -> Bool {
        if codeExpired || wrongTries >= 5 { return false }
        if submitted != code { wrongTries += 1; return false }
        return true
    }

    private func hello(_ body: Data?, url: URL) -> Reply {
        if let (laptop, address) = relay {
            // Relay attack: pass the iPad's hello, nonce included, to the real
            // laptop at its own address and hand back whatever it says.
            var forwarded = URLRequest(url: URL(string: address + "/device/v1/hello")!)
            forwarded.httpMethod = "POST"; forwarded.httpBody = body
            return laptop.handle(forwarded)
        }
        struct Body: Decodable { let code: String; let organiserProof: OrganiserProofRequest? }
        guard let body, let request = try? JSONDecoder().decode(Body.self, from: body) else { return .json(400, Data("{}".utf8)) }
        guard codeAccepted(request.code) else { return Self.invalid }
        var reply = try! JSONSerialization.jsonObject(with: DeviceProtocol.encode(offer)) as! [String: Any]
        if issuesProofKeys, let ask = request.organiserProof {
            // Like the host: signed for its own participant origin, the
            // address it is reached at (no port, no path prefix here).
            reply["organiserProof"] = OrganiserProof.sign(key: proofKey(for: ask.deviceId), deviceId: ask.deviceId,
                                                          eventId: offer.eventId, code: request.code, nonce: ask.nonce,
                                                          origin: "https://" + (url.host ?? "").lowercased())
        }
        return .json(200, try! JSONSerialization.data(withJSONObject: reply))
    }

    private func pair(_ body: Data?, bearer: String?) -> Reply {
        struct Body: Decodable { let code: String; let credentialHash: String }
        guard let body, let request = try? JSONDecoder().decode(Body.self, from: body) else { return .json(400, Data("{}".utf8)) }
        if let spent {
            // Lost-reply replay: the same hash gets the same answer.
            guard request.code == code, spent.hash == request.credentialHash else { return Self.invalid }
            return success(deviceId: spent.deviceId, hash: spent.hash)
        }
        guard codeAccepted(request.code) else { return Self.invalid }
        let proven = bearer.flatMap { proof in
            devices.first { $0.value == DeviceCredential.hash(proof) }?.key
        }
        let deviceId: String
        if let target { deviceId = target } else if let proven { deviceId = proven }
        else { deviceId = "dev_fixture_ipad\(nextDevice)"; nextDevice += 1 }
        devices[deviceId] = request.credentialHash
        spent = (request.credentialHash, deviceId)
        return success(deviceId: deviceId, hash: request.credentialHash)
    }

    private func success(deviceId: String, hash: String) -> Reply {
        .json(201, try! DeviceProtocol.encode(PairingSuccess(eventId: offer.eventId, deviceId: deviceId,
            deviceLabel: offer.deviceLabel, credentialHash: hash,
            organiserProofKey: issuesProofKeys ? proofKey(for: deviceId) : nil)))
    }

    private func authorised(_ bearer: String?) -> Bool {
        guard let bearer else { return false }
        return devices.values.contains(DeviceCredential.hash(bearer))
    }

    private static let revoked = Reply.json(401, Data(#"{"error":"device_revoked"}"#.utf8))

    private func roster(bearer: String?) -> Reply {
        guard authorised(bearer) else { return Self.revoked }
        return .json(200, try! DeviceProtocol.encode(RosterSnapshot(eventId: offer.eventId, eventCode: offer.eventCode,
            serverTime: serverTime, window: window, people: people, rosterVersion: currentVersion)))
    }

    private func heartbeat(_ body: Data?, bearer: String?) -> Reply {
        guard authorised(bearer) else { return Self.revoked }
        if let body { lastHeartbeat = try? DeviceProtocol.decode(HeartbeatReport.self, from: body) }
        return .json(200, try! DeviceProtocol.encode(HeartbeatReply(eventId: offer.eventId, serverTime: serverTime,
            window: window, rosterVersion: currentVersion)))
    }

    private func operations(_ body: Data?, bearer: String?) -> Reply {
        guard authorised(bearer) else { return Self.revoked }
        guard let body, let request = try? DeviceProtocol.decode(OperationsRequest.self, from: body),
              request.eventId == offer.eventId else { return .json(409, Data(#"{"error":"event_moved"}"#.utf8)) }
        let results = request.operations.map { op -> OperationResult in
            if let previous = outcomes[op.opId] {
                return OperationResult(opId: op.opId, outcome: previous == .applied ? .alreadyApplied : previous)
            }
            if window.state == .closed { return OperationResult(opId: op.opId, outcome: .closed) }
            guard let index = people.firstIndex(where: { $0.personToken == op.personToken }),
                  people[index].revision == op.baseRevision else {
                outcomes[op.opId] = .held; return OperationResult(opId: op.opId, outcome: .held, reason: "stale")
            }
            people[index].checkedIn = true; people[index].revision += 1; version += 1
            outcomes[op.opId] = .applied; appliedOperations.append(op)
            return OperationResult(opId: op.opId, outcome: .applied)
        }
        return .json(200, try! DeviceProtocol.encode(OperationsResponse(eventId: offer.eventId,
            serverTime: serverTime, window: window, results: results)))
    }

    private static func read(_ stream: InputStream) -> Data {
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// Routes every request of a `URLSessionNativeClient(protocolClasses:)`
/// to the current `StubLaptop`.
final class StubURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var _laptop: StubLaptop?
    private static var _strangers: [String: StubLaptop] = [:]
    static var laptop: StubLaptop? {
        get { lock.lock(); defer { lock.unlock() }; return _laptop }
        set { lock.lock(); defer { lock.unlock() }; _laptop = newValue }
    }
    /// Other HTTPS servers, by host name: someone else's server, not the laptop.
    static var strangers: [String: StubLaptop] {
        get { lock.lock(); defer { lock.unlock() }; return _strangers }
        set { lock.lock(); defer { lock.unlock() }; _strangers = newValue }
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url, let laptop = Self.strangers[url.host ?? ""] ?? Self.laptop else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost)); return
        }
        let reply = laptop.handle(request)
        let status: Int, type: String, body: Data
        var headers: [String: String] = [:]
        switch reply {
        case .rateLimited(let retryAfter):
            status = 429; type = "application/json"; body = Data(#"{"error":"rate_limited"}"#.utf8)
            headers["Retry-After"] = retryAfter
        case .noConnection:
            client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost)); return
        case .html(let code): status = code; type = "text/html"; body = Data("<html>Bad gateway</html>".utf8)
        case .json(let code, let data): status = code; type = "application/json; charset=utf-8"; body = data
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: headers.merging(["Content-Type": type]) { $1 })!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// Records backoff delays instead of sleeping.
final class SleepLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [TimeInterval] = []
    var delays: [TimeInterval] { lock.lock(); defer { lock.unlock() }; return values }
    func record(_ value: TimeInterval) { lock.lock(); values.append(value); lock.unlock() }
}

/// A controllable uptime clock for `RetryAfterGate`.
final class Uptime: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 5_000
    var now: TimeInterval { lock.lock(); defer { lock.unlock() }; return value }
    func advance(_ seconds: TimeInterval) { lock.lock(); value += seconds; lock.unlock() }
}

func instantRetry(_ log: SleepLog = SleepLog()) -> RetryPolicy {
    RetryPolicy(attempts: 3, baseDelay: 0.5, maxDelay: 4, sleep: { log.record($0) })
}

func stubClient() -> URLSessionNativeClient { URLSessionNativeClient(protocolClasses: [StubURLProtocol.self]) }

// Person tokens from contract/device-v1/roster.example.json ("pt_" + 24 hex).
let alexToken = "pt_a1e7c0de5f00a1e7c0de5f00"
let riyaToken = "pt_b2f8d1ef6a11b2f8d1ef6a11"

let liveCredential = "dc_" + String(repeating: "a", count: 43)
let tunnelA = "https://quiet-river-fixture.trycloudflare.com"
let tunnelB = "https://bright-meadow-fixture.trycloudflare.com"
/// A participant's own HTTPS server (fictional), not the organiser's laptop.
let strangerOrigin = "https://someone-elses-server.example.net"
