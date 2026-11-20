import Foundation

public enum NearbyPairingQR {
    case nearby(String)
    case internet(String)

    public init?(_ payload: String) {
        struct Pairing: Decodable {
            let v: Int
            let workshopId: String
            let key: String
        }
        let text = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        if let pairing = try? JSONDecoder().decode(Pairing.self, from: Data(text.utf8)),
           pairing.v == 1, !pairing.workshopId.isEmpty, Self.validKey(pairing.key) {
            self = .nearby(pairing.key)
            return
        }
        guard let url = URLComponents(string: text), url.scheme?.lowercased() == "https",
              url.host != nil, url.user == nil, url.password == nil, url.query == nil,
              url.percentEncodedPath.hasSuffix("/pair"), let fragment = url.fragment,
              let fields = URLComponents(string: "https://fixture.invalid/?" + fragment),
              let items = fields.queryItems, items.count == 2,
              items.contains(where: { $0.name == "v" && $0.value == "1" }),
              let code = items.first(where: { $0.name == "code" })?.value else { return nil }
        let normalised = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased().replacingOccurrences(of: "-", with: "")
        guard (8...128).contains(normalised.count),
              normalised.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else { return nil }
        // Build 2 reads only queryItems from these fields. An escaped '#'
        // becomes a separate inner fragment, leaving its two fields intact.
        let prefix = "nearby="
        guard let extensionText = fields.fragment, extensionText.hasPrefix(prefix) else {
            self = .internet(text)
            return
        }
        let key = String(extensionText.dropFirst(prefix.count))
        guard Self.validKey(key) else { return nil }
        self = .nearby(key)
    }

    private static func validKey(_ value: String) -> Bool {
        value.utf8.count == 43 && value.utf8.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        } && SharedKey(base64url: value) != nil
    }
}
