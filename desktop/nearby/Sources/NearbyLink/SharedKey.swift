import Foundation
import CryptoKit

/// The workshop's shared key (32 random bytes, base64url in a QR code) and everything derived from it:
/// the discovery tag, the invitation proof, and the sealing of every application message.
public struct SharedKey {
    public let raw: Data
    private let sealKey: SymmetricKey

    public init?(base64url: String) {
        var s = base64url.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let d = Data(base64Encoded: s), d.count == 32 else { return nil }
        raw = d
        sealKey = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: d), salt: Data("attendwell-nb".utf8), info: Data("seal-v1".utf8), outputByteCount: 32)
    }

    public static func generate() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func hmac(_ data: Data) -> Data { Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: raw))) }

    /// Discovery tag: first 16 hex characters of HMAC-SHA256(key, "attendwell-tag").
    public var tag: String { hmac(Data("attendwell-tag".utf8)).prefix(8).map { String(format: "%02x", $0) }.joined() }

    // MARK: sealing

    public func seal(_ plain: Data) throws -> Data { try ChaChaPoly.seal(plain, using: sealKey).combined }
    public func open(_ sealed: Data) throws -> Data { try ChaChaPoly.open(try ChaChaPoly.SealedBox(combined: sealed), using: sealKey) }

    // MARK: invitation context: nonce(16) | timestamp(8, seconds, big endian) | HMAC(nonce | timestamp | inviterDisplayName)

    public func makeInvitation(inviterDisplayName: String, now: Date = Date()) -> Data {
        var nonce = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, 16, &nonce)
        var ts = UInt64(now.timeIntervalSince1970).bigEndian
        let tsData = withUnsafeBytes(of: &ts) { Data($0) }
        let body = Data(nonce) + tsData
        return body + hmac(body + Data(inviterDisplayName.utf8))
    }

    /// Returns the nonce when the context is genuine and within +-5 minutes, otherwise nil.
    public func verifyInvitation(_ context: Data?, inviterDisplayName: String, now: Date = Date()) -> Data? {
        guard let c = context, c.count == 56 else { return nil }
        let body = c.prefix(24), mac = c.suffix(32)
        guard HMAC<SHA256>.isValidAuthenticationCode(mac, authenticating: body + Data(inviterDisplayName.utf8), using: SymmetricKey(data: raw)) else { return nil }
        let ts = c.subdata(in: 16..<24).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        guard abs(now.timeIntervalSince1970 - Double(ts)) <= 300 else { return nil }
        return c.prefix(16)
    }
}
