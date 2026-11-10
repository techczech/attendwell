import Foundation
import UIKit
import NearbyLink

@MainActor
final class SpikeModel: ObservableObject {
    @Published var keyText = ""
    @Published var names: [NameEntry] = []
    @Published var title = ""
    @Published var open = false
    @Published var connectedMac: String?
    @Published var pending = 0
    @Published var log: [String] = []
    @Published var checkedIn = Set<String>()
    @Published var keyError: String?

    private var client: NearbyIPadClient?
    private let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("NearbySpike")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private let formatter: DateFormatter = { let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"; return f }()
    private var logURL: URL { dir.appendingPathComponent("events.log") }

    init() {
        if let saved = UserDefaults.standard.string(forKey: "spike.pairing") { keyText = saved; connect() }
    }

    var status: String {
        let saved = pending > 0 ? " · Saved here: \(pending) to send" : ""
        if let mac = connectedMac { return "Connected to \(mac) (nearby)\(saved)" }
        if client == nil { return "Paste or scan the key" + saved }
        return "Searching" + saved
    }

    var logText: String { log.joined(separator: "\n") }

    /// Accepts the bare key or the QR's JSON {"v":1,"workshopId":...,"key":...}.
    func connect() {
        let raw = keyText.trimmingCharacters(in: .whitespacesAndNewlines)
        var keyString = raw
        if let d = raw.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let k = o["key"] as? String { keyString = k }
        guard let key = SharedKey(base64url: keyString) else { keyError = "Not a valid key"; return }
        keyError = nil
        UserDefaults.standard.set(raw, forKey: "spike.pairing")
        client?.stop()
        let c = NearbyIPadClient(key: key, deviceName: Self.deviceName, queue: PendingQueue(url: dir.appendingPathComponent("queue.json")))
        c.onLog = { [weak self] in self?.add($0) }
        c.onPeer = { [weak self] peer, state in self?.add("peer \(peer) \(state.rawValue)"); self?.connectedMac = c.connectedMac }
        c.onSnapshot = { [weak self] s, bytes in
            self?.add("snapshot v\(s.version) names=\(s.names.count) bytes=\(bytes) open=\(s.open)")
            self?.names = s.names; self?.title = s.title; self?.open = s.open
        }
        c.onQueueChanged = { [weak self] n in self?.pending = n }
        client = c
        pending = c.pendingCount
        if pending > 0 { add("replaying \(pending) saved check-ins on connect") }
        c.start()
    }

    func checkIn(_ n: NameEntry) {
        guard let c = client else { return }
        let x = c.checkIn(nameId: n.id)
        checkedIn.insert(n.id)
        add("checkin \(n.displayName) op=\(x.opId.prefix(8))")
    }

    func appDidBecomeActive() { add("foreground"); client?.appDidBecomeActive() }

    func add(_ s: String) {
        let line = "\(formatter.string(from: Date())) \(s)"
        log.append(line)
        if log.count > 2000 { log.removeFirst(500) }
        if let h = try? FileHandle(forWritingTo: logURL) { h.seekToEndOfFile(); h.write(Data((line + "\n").utf8)); try? h.close() }
        else { try? Data((line + "\n").utf8).write(to: logURL) }
    }

    static var deviceName: String {
        #if targetEnvironment(simulator)
        return "iPad-sim-\(Int.random(in: 100...999))"
        #else
        return "iPad-\(UIDevice.current.name)"
        #endif
    }
}
