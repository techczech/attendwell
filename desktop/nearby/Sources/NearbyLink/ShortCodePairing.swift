import CommonCrypto
import Foundation
import Network
import Security

private let pairingType = "_attendwell-pair._tcp"
private let alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
// TLS 1.2 ECDHE-PSK. Ephemeral Diffie-Hellman keeps a recorded exchange
// confidential even if someone subsequently learns the temporary code.
private let pairingSuite = tls_ciphersuite_t(rawValue: 0xC035)!

private func parameters(code: String, service: String) -> NWParameters {
    let password = Array(code.utf8), salt = Array(("AttendWell pairing v1/" + service).utf8)
    var derived = [UInt8](repeating: 0, count: 32)
    let status = CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password,
        password.count, salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
        100_000, &derived, 32)
    precondition(status == kCCSuccess)
    let tls = NWProtocolTLS.Options()
    let options = tls.securityProtocolOptions
    sec_protocol_options_set_min_tls_protocol_version(options, .TLSv12)
    sec_protocol_options_set_max_tls_protocol_version(options, .TLSv12)
    sec_protocol_options_append_tls_ciphersuite(options, pairingSuite)
    derived.withUnsafeBytes { bytes in
        Array("AttendWell".utf8).withUnsafeBytes { identity in
            sec_protocol_options_add_pre_shared_key(options, DispatchData(bytes: bytes) as __DispatchData,
                DispatchData(bytes: identity) as __DispatchData)
        }
    }
    let config = NWParameters(tls: tls)
    config.includePeerToPeer = true
    return config
}

private func authenticated(_ connection: NWConnection) -> Bool {
    guard let tls = connection.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata else { return false }
    return sec_protocol_metadata_get_negotiated_tls_ciphersuite(tls.securityProtocolMetadata) == pairingSuite
}

/// One local, single-use transfer. The helper keeps it open only while the Mac pairing sheet is visible.
public final class ShortCodeHost {
    public let code = String((0..<8).map { _ in alphabet.randomElement()! })
    let serviceName = UUID().uuidString
    private let listener: NWListener
    private let key: String
    private var pending: [ObjectIdentifier: NWConnection] = [:]
    public var onReady: (() -> Void)?
    public var onEnd: (() -> Void)?
    private var stopped = false
    private var spent = false
    private var attempts = 0
    var port: NWEndpoint.Port? { listener.port }

    public init(key: String) throws {
        self.key = key
        listener = try NWListener(using: parameters(code: code, service: serviceName))
    }
    public func start() {
        listener.service = NWListener.Service(name: serviceName, type: pairingType)
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.onReady?()
            case .failed: self?.stop()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, !self.stopped, !self.spent, self.pending.count < 6, self.attempts < 24 else {
                connection.cancel(); return
            }
            self.attempts += 1
            let id = ObjectIdentifier(connection)
            self.pending[id] = connection
            connection.stateUpdateHandler = { [weak self, weak connection] state in
                guard let self, let connection, !self.stopped else { return }
                switch state {
                case .ready:
                    guard !self.spent, authenticated(connection) else { connection.cancel(); return }
                    self.spent = true
                    connection.send(content: Data(self.key.utf8), completion: .contentProcessed { [weak self] _ in self?.stop() })
                case .failed, .cancelled:
                    connection.cancel()
                    self.pending[id] = nil
                    if self.pending.isEmpty && self.attempts >= 24 { self.stop() }
                default: break
                }
            }
            connection.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak connection] in connection?.cancel() }
        }
        listener.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in self?.stop() }
    }
    public func stop() {
        guard !stopped else { return }
        stopped = true
        listener.cancel()
        for connection in pending.values { connection.cancel() }
        pending.removeAll()
        onEnd?()
    }
}

public final class ShortCodeClient {
    private let code: String
    private var completion: ((String?) -> Void)?
    private var browser: NWBrowser?
    private var connections: [NWEndpoint: NWConnection] = [:]
    public static func normalise(_ text: String) -> String? {
        let s = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return s.count == 8 && s.allSatisfy(alphabet.contains) ? s : nil
    }
    public init(code: String, completion: @escaping (String?) -> Void) {
        self.code = code
        self.completion = completion
    }
    public func start() {
        let browseParams = NWParameters()
        browseParams.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: pairingType, domain: nil), using: browseParams)
        browser = b
        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            for result in results {
                guard case let .service(name, _, _, _) = result.endpoint, UUID(uuidString: name) != nil,
                      self.connections[result.endpoint] == nil, self.connections.count < 8 else { continue }
                self.connect(to: result.endpoint, serviceName: name)
            }
        }
        b.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) { [weak self] in self?.finish(nil) }
    }
    func connect(to endpoint: NWEndpoint, serviceName: String) {
        let c = NWConnection(to: endpoint, using: parameters(code: code, service: serviceName))
        connections[endpoint] = c
        c.stateUpdateHandler = { [weak self, weak c] state in
            guard let self, let c, self.completion != nil else { return }
            switch state {
            case .ready:
                guard authenticated(c) else { c.cancel(); return }
                c.receive(minimumIncompleteLength: 43, maximumLength: 43) { [weak self] data, _, _, _ in
                    guard let data, data.count == 43, let value = String(data: data, encoding: .ascii),
                          SharedKey(base64url: value) != nil else { return }
                    self?.finish(value)
                }
            case .failed, .waiting:
                if self.browser == nil { self.finish(nil) }
            default: break
            }
        }
        c.start(queue: .main)
    }
    private func finish(_ key: String?) {
        let callback = completion
        stop()
        callback?(key)
    }
    public func stop() {
        completion = nil
        browser?.cancel()
        browser = nil
        connections.values.forEach { $0.cancel() }
        connections.removeAll()
    }
}
