import Foundation

/// The iPad's unacknowledged check-ins. A new queue replaces the old file
/// atomically before the UI reports a save or the client sends anything.
public final class PendingQueue {
    public private(set) var items: [CheckIn] = []
    private let url: URL
    private var loadError: Error?

    public init(url: URL) {
        self.url = url
        do {
            items = try JSONDecoder().decode([CheckIn].self, from: Data(contentsOf: url))
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // A pairing may not have recorded its first check-in yet.
        } catch {
            loadError = error
        }
    }

    public func append(_ c: CheckIn) throws { try save(items + [c]) }

    public func remove(opIds: [String]) throws {
        let gone = Set(opIds)
        let next = items.filter { !gone.contains($0.opId) }
        if next.count != items.count { try save(next) }
    }

    private func save(_ next: [CheckIn]) throws {
        if let loadError { throw loadError }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: url, options: .atomic)
        items = next
    }
}
