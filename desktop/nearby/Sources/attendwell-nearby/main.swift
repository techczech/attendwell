// attendwell-nearby --role mac        advertises; parent talks JSON lines on stdin/stdout
// attendwell-nearby --role ipad-sim   headless fake iPad for measurement: --queue <file> [--count N] [--interval-ms N] [--device name]
// The shared key arrives on stdin as the first line {"type":"key","key":...,"workshopId":...}; never on argv.
import Foundation
import NearbyLink

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
func arg(_ name: String) -> String? { args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }

func emit(_ type: String, _ fields: [String: Any] = [:]) {
    var o = fields
    o["type"] = type
    o["t"] = monotonicMs()
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(d + Data("\n".utf8))
}
func log(_ s: String) { emit("log", ["msg": s]) }

guard let role = arg("--role"), role == "mac" || role == "ipad-sim" else {
    FileHandle.standardError.write(Data("usage: attendwell-nearby --role mac|ipad-sim\n".utf8)); exit(2)
}

/// Reads stdin lines on a background thread and delivers them on the main queue. EOF calls onEOF.
func readLines(_ onLine: @escaping (Data) -> Void, onEOF: @escaping () -> Void) {
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }
            DispatchQueue.main.async { onLine(Data(line.utf8)) }
        }
        DispatchQueue.main.async(execute: onEOF)
    }
}

func parseKeyLine(_ d: Data) -> (SharedKey, String)? {
    guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], o["type"] as? String == "key",
          let k = o["key"] as? String, let key = SharedKey(base64url: k) else { return nil }
    return (key, o["workshopId"] as? String ?? "")
}

let hostName = Host.current().localizedName ?? "Mac"

if role == "mac" {
    var host: NearbyMacHost?
    readLines({ line in
        if host == nil {
            guard let (key, _) = parseKeyLine(line) else { log("first line must be the key"); exit(3) }
            let h = NearbyMacHost(key: key, deviceName: arg("--device") ?? hostName)
            h.onLog = log
            h.onPeer = { peer, state in emit("peer", ["state": state.rawValue, "peer": peer]) }
            h.onSnapshotSent = { peer, bytes in emit("snapshot-sent", ["peer": peer, "bytes": bytes]) }
            h.onCheckin = { c, peer in emit("checkin", ["opId": c.opId, "nameId": c.nameId, "at": c.at, "peer": peer]) }
            host = h
            h.start()
            emit("ready")
            return
        }
        guard let o = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }
        switch o["type"] as? String {
        case "snapshot": if let m = try? JSONDecoder().decode(Message.self, from: line), case .snapshot(let s) = m { host?.setSnapshot(s); emit("snapshot-set", ["version": s.version, "names": s.names.count]) }
        case "ack": host?.ack(opIds: o["opIds"] as? [String] ?? [])
        default: break
        }
    }, onEOF: { host?.stop(); exit(0) })
} else {
    guard let queuePath = arg("--queue") else { FileHandle.standardError.write(Data("--queue <file> required\n".utf8)); exit(2) }
    let count = Int(arg("--count") ?? "0") ?? 0
    let intervalMs = Int(arg("--interval-ms") ?? "5") ?? 5
    let progressURL = URL(fileURLWithPath: queuePath + ".next")
    var next = Int((try? String(contentsOfFile: progressURL.path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "0") ?? 0
    var client: NearbyIPadClient?
    var producing = false

    // Deterministic op ids and name ids: the Nth check-in is always the same operation, so a relaunch cannot invent new ones.
    func opId(_ i: Int) -> String { String(format: "00000000-0000-4000-8000-%012x", i) }
    func produce() {
        guard let c = client, next < count else { producing = false; return }
        let i = next
        next += 1
        // Queue first, progress second: a kill in between repeats the same opId (the Mac dedups) instead of losing one.
        _ = c.checkIn(nameId: "n\(i % 500)", opId: opId(i))
        try? String(next).write(to: progressURL, atomically: true, encoding: .utf8)
        emit("checkin-created", ["index": i, "opId": opId(i)])
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(intervalMs), execute: produce)
    }
    func finishIfDone() {
        if next >= count && count > 0 && client?.pendingCount == 0 { emit("done", ["produced": next]) }
    }

    readLines({ line in
        guard client == nil else { return }
        guard let (key, _) = parseKeyLine(line) else { log("first line must be the key"); exit(3) }
        let c = NearbyIPadClient(key: key, deviceName: arg("--device") ?? "ipad-sim", queue: PendingQueue(url: URL(fileURLWithPath: queuePath)))
        c.onLog = log
        c.onPeer = { peer, state in emit("peer", ["state": state.rawValue, "peer": peer]) }
        c.onSnapshot = { s, bytes in
            emit("snapshot", ["version": s.version, "names": s.names.count, "bytes": bytes])
            if !producing && next < count { producing = true; produce() }
        }
        c.onQueueChanged = { n in emit("queue", ["unacked": n]); finishIfDone() }
        client = c
        c.start()
        emit("ready", ["resumeAt": next, "queued": c.pendingCount])
    }, onEOF: {})
}

RunLoop.main.run()
