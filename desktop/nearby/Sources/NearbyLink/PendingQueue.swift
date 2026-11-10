import Foundation

/// The iPad's check-ins that the Mac has not yet acknowledged, kept in a JSON file (atomic write) so a kill and relaunch replays them.
public final class PendingQueue {
    public private(set) var items: [CheckIn]
    private let url: URL

    public init(url: URL) {
        self.url = url
        if let d = try? Data(contentsOf: url), let decoded = try? JSONDecoder().decode([CheckIn].self, from: d) { items = decoded } else { items = [] }
    }

    public func append(_ c: CheckIn) { items.append(c); save() }

    public func remove(opIds: [String]) {
        let gone = Set(opIds)
        let before = items.count
        items.removeAll { gone.contains($0.opId) }
        if items.count != before { save() }
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let d = try? JSONEncoder().encode(items) { try? d.write(to: url, options: .atomic) }
    }
}
