import XCTest
import NearbyLink

/// Connects to the Mac helper running on the host (see desktop/nearby/spike/sim-test.mjs), receives the snapshot and round-trips
/// 20 check-ins. Needs NEARBY_KEY (pass it as TEST_RUNNER_NEARBY_KEY to xcodebuild); skipped otherwise.
/// Optional NEARBY_RESULT_FILE: where to write the measured times as JSON.
final class SimulatorRoundTripTests: XCTestCase {
    func testSnapshotAndTwentyCheckins() throws {
        let env = ProcessInfo.processInfo.environment
        guard let keyString = env["NEARBY_KEY"], let key = SharedKey(base64url: keyString) else { throw XCTSkip("NEARBY_KEY not set") }
        let queueURL = FileManager.default.temporaryDirectory.appendingPathComponent("nearby-test-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: queueURL) }
        let client = NearbyIPadClient(key: key, deviceName: "iPad-xctest-\(Int.random(in: 100...999))", queue: PendingQueue(url: queueURL))
        var lines: [String] = []
        var ids: [String] = []
        var snapshotAt: TimeInterval = 0
        var ackedAfter: TimeInterval = 0
        let t0 = Date()
        client.onLog = { lines.append(String(format: "+%.3fs ", Date().timeIntervalSince(t0)) + $0) }
        client.onPeer = { p, st in lines.append(String(format: "+%.3fs peer %@ %@", Date().timeIntervalSince(t0), p, st.rawValue)) }
        // Written even when the test fails: the failure log is the evidence for "does Simulator <-> host Multipeer work".
        defer {
            if let path = env["NEARBY_RESULT_FILE"] {
                let result: [String: Any] = ["connectAndSnapshotSeconds": snapshotAt, "twentyCheckinsAckedSeconds": ackedAfter, "opIds": ids, "log": lines]
                try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted]).write(to: URL(fileURLWithPath: path))
            }
        }

        let gotSnapshot = expectation(description: "snapshot")
        var snapshot: Snapshot?
        client.onSnapshot = { s, _ in if snapshot == nil { snapshot = s; snapshotAt = Date().timeIntervalSince(t0); gotSnapshot.fulfill() } }
        let drained = expectation(description: "all acked")
        var sent = false
        client.onQueueChanged = { n in if sent && n == 0 { drained.fulfill() } }
        client.start()
        defer { client.stop() }

        wait(for: [gotSnapshot], timeout: 40)
        guard let snapshot, snapshot.names.count == 500 else { XCTFail("no 500-name snapshot received"); return }

        let t1 = Date()
        sent = true
        for i in 0..<20 { ids.append(client.checkIn(nameId: snapshot.names[i].id).opId) }
        wait(for: [drained], timeout: 40)
        ackedAfter = Date().timeIntervalSince(t1)
        XCTAssertEqual(client.pendingCount, 0)
    }
}
