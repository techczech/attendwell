import Foundation
import SQLite3
import XCTest
import WorkshopCheckInCore

// All names, tokens and event ids below are fictional.

let eventA = "evt_fixture_spring"
let eventB = "evt_fixture_autumn"
let alex = RosterPerson(personToken: "pt_alex", displayName: "Alex Morgan", revision: 1, checkedIn: false)
let riya = RosterPerson(personToken: "pt_riya", displayName: "Riya Shah", revision: 1, checkedIn: false)
let sam = RosterPerson(personToken: "pt_sam", displayName: "Sam Taylor", revision: 1, checkedIn: false)
let jo = RosterPerson(personToken: "pt_jo", displayName: "Jo Okafor", revision: 3, checkedIn: true)

func isoDate(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
let nineAM = isoDate("2026-10-14T09:00:00Z")

/// Controllable wall clock, monotonic clock and boot identity.
final class FakeClock: CheckInClock, @unchecked Sendable {
    private let lock = NSLock()
    private var wall: Date
    private var monotonic: TimeInterval = 1_000
    private var boot = "boot-1"

    init(wall: Date = nineAM) { self.wall = wall }

    func wallNow() -> Date { lock.lock(); defer { lock.unlock() }; return wall }
    func monotonicSeconds() -> TimeInterval { lock.lock(); defer { lock.unlock() }; return monotonic }
    func bootID() -> String { lock.lock(); defer { lock.unlock() }; return boot }

    /// Real time passing: wall and monotonic move together.
    func advance(_ seconds: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        wall += seconds
        monotonic += seconds
    }

    /// Someone changes the device clock; monotonic time is unaffected.
    func setWall(_ date: Date) { lock.lock(); defer { lock.unlock() }; wall = date }

    func reboot(wallAfter: Date) {
        lock.lock(); defer { lock.unlock() }
        boot += "+"
        monotonic = 30
        wall = wallAfter
    }
}

final class TempDirectory {
    let url: URL
    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkshopCheckInCoreTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    var storeFile: URL { url.appendingPathComponent("Application Support/check-ins.sqlite") }
    deinit { try? FileManager.default.removeItem(at: url) }
}

func openWindow(closesAt: Date? = nil, revision: Int = 1) -> WindowInfo {
    WindowInfo(state: .open, revision: revision, openedAt: nineAM, closesAt: closesAt)
}

func roster(_ eventId: String = eventA, code: String = "7Q2M", at serverTime: Date = nineAM,
            window: WindowInfo = openWindow(), people: [RosterPerson] = [alex, riya, sam, jo]) -> RosterSnapshot {
    RosterSnapshot(eventId: eventId, eventCode: code, serverTime: serverTime, window: window, people: people)
}

func makeHost(_ eventId: String = eventA, clock: FakeClock, people: [RosterPerson] = [alex, riya, sam, jo],
              window: WindowInfo = openWindow()) -> FixtureHost {
    FixtureHost(eventId: eventId, eventCode: "7Q2M", people: people, window: window, now: { clock.wallNow() })
}

func savedOpId(_ outcome: RecordOutcome, file: StaticString = #filePath, line: UInt = #line) -> UUID? {
    guard case .saved(let opId) = outcome else {
        XCTFail("expected .saved, got \(outcome)", file: file, line: line)
        return nil
    }
    return opId
}

/// Runs SQL on the store's file through a separate connection, as another
/// process or a failing disk would. Returns the open handle so a caller can
/// keep a lock; close it with `sqlite3_close`.
@discardableResult
func rawSQL(_ file: URL, _ sql: String, keepOpen: Bool = false) -> OpaquePointer? {
    var handle: OpaquePointer?
    XCTAssertEqual(sqlite3_open(file.path, &handle), SQLITE_OK)
    XCTAssertEqual(sqlite3_exec(handle, sql, nil, nil, nil), SQLITE_OK, String(cString: sqlite3_errmsg(handle)))
    if keepOpen { return handle }
    sqlite3_close(handle)
    return nil
}

/// Wraps the fixture host with scripted faults, one per request.
actor FaultyTransport: DeviceTransport {
    enum Fault { case loseReply, fail(TransportFailure), garbage, emailInReply }
    let host: FixtureHost
    private var faults: [Fault]
    private(set) var requestCount = 0

    init(host: FixtureHost, faults: [Fault]) {
        self.host = host
        self.faults = faults
    }

    func submitOperations(eventId: String, body: Data) async throws -> Data {
        requestCount += 1
        let fault = faults.isEmpty ? nil : faults.removeFirst()
        switch fault {
        case .fail(let failure):
            throw failure
        case .loseReply:
            _ = try await host.submitOperations(eventId: eventId, body: body)
            throw TransportFailure.timedOut
        case .garbage:
            return Data("<html>gateway</html>".utf8)
        case .emailInReply:
            let reply = try await host.submitOperations(eventId: eventId, body: body)
            var object = try JSONSerialization.jsonObject(with: reply) as! [String: Any]
            object["contactEmail"] = "someone@example.invalid"
            return try JSONSerialization.data(withJSONObject: object)
        case nil:
            return try await host.submitOperations(eventId: eventId, body: body)
        }
    }
}

/// Holds every request until `open()`; counts arrivals.
actor Gate {
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var isOpen = false
    private(set) var arrivals = 0

    func pass() async {
        arrivals += 1
        if isOpen { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }

    func waitForArrivals(_ count: Int) async {
        while arrivals < count { await Task.yield() }
    }
}

struct DelayedTransport: DeviceTransport {
    let host: FixtureHost
    let gate: Gate

    func submitOperations(eventId: String, body: Data) async throws -> Data {
        await gate.pass()
        return try await host.submitOperations(eventId: eventId, body: body)
    }
}
