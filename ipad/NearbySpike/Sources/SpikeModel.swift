import Foundation
import UIKit
import NearbyLink

@MainActor
final class SpikeModel: ObservableObject {
    @Published private(set) var hasPairing = false
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var connectedMac: String?
    @Published private(set) var pending = 0
    @Published private(set) var pendingNames: Set<String> = []
    @Published private(set) var confirmation: String?
    @Published private(set) var error: String?

    private let allowSpike: Bool
    private var client: NearbyIPadClient?
    private var pairingTag: String?
    private var confirmationTask: Task<Void, Never>?
    private let pairingPreference = "spike.pairing"

    init(allowSpike: Bool = true) {
        self.allowSpike = allowSpike
        #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
        if let state = ProcessInfo.processInfo.arguments.dropFirst().first(where: { $0.hasPrefix("--startup-") }) {
            preview(state)
            return
        }
        #endif
        if let saved = UserDefaults.standard.string(forKey: pairingPreference),
           let key = Self.sharedKey(from: saved) {
            connect(key, remember: nil)
        }
    }

    var status: String {
        if let mac = connectedMac { return "Connected to \(mac)" }
        return "Looking for the Mac"
    }

    func invalidCode() {
        error = "This QR code is not an AttendWell pairing code."
    }

    func pair(_ keyText: String) {
        guard let key = SharedKey(base64url: keyText) else {
            invalidCode()
            return
        }
        guard key.tag != pairingTag else {
            error = nil
            client?.appDidBecomeActive()
            return
        }
        guard pending == 0 else {
            error = "Send the saved check-ins to this Mac before connecting to a different one."
            return
        }
        connect(key, remember: keyText)
    }

    func checkIn(_ name: NameEntry) {
        guard let snapshot, snapshot.open, !name.hidden, !isCheckedIn(name) else { return }
        #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
        if client == nil && hasPairing {
            pendingNames.insert(name.id)
            pending += 1
            showConfirmation(for: name)
            return
        }
        #endif
        guard let client else { return }
        do {
            try client.checkIn(nameId: name.id, workshopId: snapshot.acceptsWorkshopCheckIns == true ? snapshot.workshopId : nil)
            error = nil
            showConfirmation(for: name)
        } catch {
            self.error = "This check-in could not be saved. Try again or speak to the organiser."
        }
    }

    func isCheckedIn(_ name: NameEntry) -> Bool {
        name.checkedIn == true || pendingNames.contains(name.id)
    }

    func appDidBecomeActive() { client?.appDidBecomeActive() }

    private func showConfirmation(for name: NameEntry) {
        confirmationTask?.cancel()
        confirmation = "Checked in · \(name.displayName)"
        confirmationTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled { self?.confirmation = nil }
        }
    }

    private static func sharedKey(from saved: String) -> SharedKey? {
        // Builds 1 and 2 could store either the bare key or the full QR text.
        let json = try? JSONSerialization.jsonObject(with: Data(saved.utf8)) as? [String: Any]
        return SharedKey(base64url: json?["key"] as? String ?? saved)
    }

    private func connect(_ key: SharedKey, remember: String?) {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var directory = allowSpike ? support.appendingPathComponent("NearbySpike") :
            support.appendingPathComponent("AttendWellNearby").appendingPathComponent(key.tag)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var excluded = URLResourceValues()
            excluded.isExcludedFromBackup = true
            try directory.setResourceValues(excluded)
        } catch {
            self.error = "AttendWell could not open check-in storage. Please speak to the organiser."
            return
        }
        let snapshotURL = directory.appendingPathComponent("snapshot.json")
        client?.stop()
        confirmationTask?.cancel()
        confirmation = nil
        connectedMac = nil
        snapshot = (try? Data(contentsOf: snapshotURL)).flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) }
        let queue = PendingQueue(url: directory.appendingPathComponent("queue.json"))
        let next = NearbyIPadClient(key: key, deviceName: Self.deviceName, queue: queue)
        next.onPeer = { [weak self, weak next] _, _ in self?.connectedMac = next?.connectedMac }
        next.onSnapshot = { [weak self] snapshot, _ in
            guard let self else { return }
            guard self.allowSpike || snapshot.acceptsWorkshopCheckIns == true else {
                self.error = "Update AttendWell on the Mac to use nearby check-in."
                return
            }
            self.error = nil
            self.snapshot = snapshot
            self.refreshQueue()
            if let data = try? JSONEncoder().encode(snapshot) { try? data.write(to: snapshotURL, options: .atomic) }
        }
        next.onQueueChanged = { [weak self] _ in self?.refreshQueue() }
        client = next
        pairingTag = key.tag
        hasPairing = true
        error = nil
        if let remember { UserDefaults.standard.set(remember, forKey: pairingPreference) }
        refreshQueue()
        next.start()
    }

    private func refreshQueue() {
        pending = client?.pendingCount ?? 0
        let workshopId = snapshot?.acceptsWorkshopCheckIns == true ? snapshot?.workshopId : nil
        pendingNames = client?.pendingNames(for: workshopId) ?? []
    }

    private static var deviceName: String {
        #if targetEnvironment(simulator)
        "iPad-sim-\(Int.random(in: 100...999))"
        #else
        UIDevice.current.name
        #endif
    }

    #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
    private func preview(_ state: String) {
        guard state != "--startup-setup", !state.hasPrefix("--startup-internet-") else { return }
        if state == "--startup-storage-error" {
            error = "AttendWell could not open check-in storage. Please speak to the organiser."
            return
        }
        hasPairing = true
        guard state != "--startup-reconnecting" else { return }
        connectedMac = "Workshop Mac"
        let names = ["Alex Morgan", "Riya Shah", "Sam Taylor", "Jo Okafor"].enumerated().map {
            NameEntry(id: String($0.offset), displayName: $0.element, hidden: false, checkedIn: $0.offset == 3)
        }
        if state == "--startup-no-workshop" {
            snapshot = Snapshot(version: 1, workshopId: "", title: "No workshop open on the Mac", open: false, names: [])
        } else {
            snapshot = Snapshot(version: 1, workshopId: "fictional", title: "Spring Workshop", open: state != "--startup-closed", names: names)
        }
    }
    #endif
}
