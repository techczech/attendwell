import Foundation
import XCTest
@testable import WorkshopCheckInCore
import WorkshopCheckInUI

/// The real HTTPS transport against a recorded fictional laptop: pairing
/// from the QR, the session cache refreshed by roster version, offline check-ins and
/// re-pairing to a new quick-tunnel address with queued check-ins.
@MainActor
final class LiveHostTests: XCTestCase {
    private var laptop: StubLaptop!

    override func setUp() async throws {
        laptop = try StubLaptop(origin: URL(string: tunnelA)!.host!)
        StubURLProtocol.laptop = laptop
    }
    override func tearDown() async throws { StubURLProtocol.laptop = nil; StubURLProtocol.strangers = [:] }

    private struct Rig {
        let dir: TempDirectory; let store: CheckInStore; let vault: FixtureCredentialVault
        let transport: LiveHostTransport; let model: KioskModel; let clock: FakeClock; let sleeps: SleepLog
        let uptime: Uptime; let pins: FixturePINVault
    }

    private func rig(credentials: [String] = [liveCredential, "dc_" + String(repeating: "b", count: 43)]) throws -> Rig {
        let dir = try TempDirectory(); let clock = FakeClock(wall: isoDate("2026-10-14T09:00:00Z"))
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        let vault = FixtureCredentialVault(); let sleeps = SleepLog(); let uptime = Uptime(); let pins = FixturePINVault()
        let transport = LiveHostTransport(vault: vault, store: store, client: stubClient(), retry: instantRetry(sleeps),
                                          rateLimit: RetryAfterGate(now: { uptime.now }))
        let queue = CredentialQueue(credentials)
        let pairing = PairingCoordinator(vault: vault, store: store, transport: transport, generate: { queue.next() })
        let model = KioskModel(store: store, credentials: vault, pairing: pairing,
                               pin: OrganiserPIN(vault: pins, clock: clock), transport: transport, fictional: false)
        return Rig(dir: dir, store: store, vault: vault, transport: transport, model: model, clock: clock, sleeps: sleeps,
                   uptime: uptime, pins: pins)
    }

    /// Scan → confirm → PIN → names, as the organiser does at the door.
    private func pairByQR(_ rig: Rig, _ qr: String) async {
        await rig.model.scan(qr)
        XCTAssertEqual(rig.model.screen, .confirmEvent)
        await rig.model.confirmPairing()
        XCTAssertEqual(rig.model.screen, .setPIN)
        await rig.model.setPIN("123456", confirmation: "123456")
    }

    // MARK: Transport against recorded fixtures

    func testPairingAndDeliverySpeakDeviceV1WithTheBearerOnlyInItsHeader() async throws {
        let rig = try rig()
        XCTAssertEqual(rig.model.address, ""); XCTAssertEqual(rig.model.code, "")
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM-4TZP")
        XCTAssertEqual(rig.model.screen, .home)
        XCTAssertEqual(rig.model.offer?.eventName, "Spring Workshop")
        XCTAssertEqual(rig.model.rows.map(\.displayName), ["Alex Morgan", "Jo Okafor", "Riya Shah"])
        rig.model.select(rig.model.findRows.first!); rig.model.saveSelected()
        await rig.model.sendNow()
        XCTAssertEqual(rig.model.rows.first?.status, .checkedIn)

        XCTAssertEqual(laptop.paths, ["/device/v1/hello", "/device/v1/pair", "/device/v1/roster",
                                      "/device/v1/heartbeat", "/device/v1/operations"])
        let hash = DeviceCredential.hash(liveCredential)
        for seen in laptop.requests {
            XCTAssertEqual(seen.url.scheme, "https"); XCTAssertNil(seen.url.query); XCTAssertNil(seen.url.fragment)
            XCTAssertFalse(seen.url.absoluteString.contains("dc_"), "no credential in a URL")
            XCTAssertEqual(seen.headers["X-Attendance-Device-Protocol"], "1")
            for header in ["Origin", "Cookie", "Sec-Fetch-Site"] { XCTAssertNil(seen.headers[header]) }
            let body = seen.body.map { String(decoding: $0, as: UTF8.self) } ?? ""
            XCTAssertFalse(body.contains(liveCredential), "the credential itself never leaves the iPad in a body")
            switch seen.url.lastPathComponent {
            case "hello", "pair": XCTAssertNil(seen.headers["Authorization"])
            default: XCTAssertEqual(seen.headers["Authorization"], "Bearer " + liveCredential)
            }
        }
        let pairBody = try XCTUnwrap(laptop.requests[1].body)
        XCTAssertTrue(String(decoding: pairBody, as: UTF8.self).contains(hash))
        // The recorded pair reply is exactly what this credential produces.
        let recorded = try DeviceProtocol.decode(PairingSuccess.self, from: contractFixture("pairing-success.example.json"))
        XCTAssertEqual(recorded.credentialHash, hash)
        XCTAssertEqual(try rig.vault.read().active?.address, tunnelA)
        XCTAssertNil(try rig.vault.read().pending)
    }

    func testGatewayPagesRetryWithBackoffAndThenLeaveTheCheckInPending() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let outcome = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        // Tunnel up, laptop app restarting: two gateway pages, then an answer.
        laptop.script([.html(502), .html(530)])
        var report = await rig.store.deliverPending(eventId: eventA, via: rig.transport)
        XCTAssertEqual(report.stop, .drained); XCTAssertEqual(report.acknowledged, [savedOpId(outcome)!])
        XCTAssertEqual(rig.sleeps.delays.count, 2)
        XCTAssertTrue(rig.sleeps.delays[0] >= 0.25 && rig.sleeps.delays[0] <= 0.5, "\(rig.sleeps.delays)")
        XCTAssertTrue(rig.sleeps.delays[1] >= 0.5 && rig.sleeps.delays[1] <= 1.0, "\(rig.sleeps.delays)")

        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: riyaToken)
        let riyaOp = try rig.store.opId(eventId: eventA, personToken: riyaToken)
        laptop.script([.html(502), .html(502), .html(502)])
        report = await rig.store.deliverPending(eventId: eventA, via: rig.transport)
        XCTAssertEqual(report.stop, .transport(.unreachable))
        XCTAssertEqual(try rig.store.status(eventId: eventA, personToken: riyaToken), .savedOnThisIPad)
        report = await rig.store.deliverPending(eventId: eventA, via: rig.transport)
        XCTAssertEqual(report.acknowledged, [riyaOp!], "the same opId is resent and applied once")
        XCTAssertEqual(laptop.applied.map(\.opId), [savedOpId(outcome)!, riyaOp!].map { $0.uuidString.lowercased() })
    }

    func testRateLimitAndDefiniteAnswersAreNotRetried() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        let before = laptop.requests.count
        laptop.script([.json(429, Data(#"{"error":"rate_limited"}"#.utf8))])
        var report = await rig.store.deliverPending(eventId: eventA, via: rig.transport)
        XCTAssertEqual(report.stop, .transport(.rateLimited))
        rig.uptime.advance(61)
        laptop.script([.json(401, try contractFixture("error-device-revoked.example.json"))])
        report = await rig.store.deliverPending(eventId: eventA, via: rig.transport)
        XCTAssertEqual(report.stop, .transport(.revoked))
        XCTAssertEqual(laptop.requests.count, before + 2)
        XCTAssertTrue(rig.sleeps.delays.isEmpty)
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 1)
    }

    func testTLSIsTheSystemsAndTheAppNamesAttendWellWithoutTransportExceptions() throws {
        let client = URLSessionNativeClient()
        XCTAssertFalse(client.responds(to: #selector(URLSessionDelegate.urlSession(_:didReceive:completionHandler:))),
                       "no session-level trust override")
        XCTAssertFalse(client.responds(to: #selector(URLSessionTaskDelegate.urlSession(_:task:didReceive:completionHandler:))),
                       "no task-level trust override")
        var plistURL = contractDirectory; plistURL.deleteLastPathComponent(); plistURL.deleteLastPathComponent()
        plistURL.appendPathComponent("iPad/Info.plist")
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: plistURL),
                                                                          format: nil) as? [String: Any])
        XCTAssertEqual(plist["CFBundleDisplayName"] as? String, "AttendWell")
        XCTAssertEqual(plist["CFBundleName"] as? String, "AttendWell")
        XCTAssertEqual(plist["CFBundleIdentifier"] as? String, "net.dominiklukes.attendwell.ipad", "bundle id is the AttendWell iPad id")
        XCTAssertNil(plist["NSAppTransportSecurity"], "no ATS exceptions")
    }

    // MARK: Pairing from the QR

    func testQuickTunnelAndOrganiserDomainQRCodesParseAndOthersAreRefused() throws {
        let (tunnel, code) = try ParticipantAddress.pairingQR(tunnelA + "/pair#v=1&code=K7QM-4TZP")
        XCTAssertEqual(code, "K7QM4TZP")
        XCTAssertEqual(try tunnel.endpoint("hello").absoluteString, tunnelA + "/device/v1/hello")
        let (domain, _) = try ParticipantAddress.pairingQR("https://checkin.example.org/s/k3v9/pair#v=1&code=K7QM4TZP")
        XCTAssertEqual(try domain.endpoint("roster").absoluteString, "https://checkin.example.org/s/k3v9/device/v1/roster")
        for bad in ["http://quiet-river-fixture.trycloudflare.com/pair#v=1&code=K7QM4TZP",
                    tunnelA + "/pair?code=K7QM4TZP",
                    tunnelA + "/pair#v=2&code=K7QM4TZP",
                    tunnelA + "/pair#v=1",
                    tunnelA + "/pair#v=1&code=K7QM4TZP&next=x",
                    tunnelA + "/join#v=1&code=K7QM4TZP",
                    "https://user@quiet-river-fixture.trycloudflare.com/pair#v=1&code=K7QM4TZP",
                    tunnelA + "/pair#v=1&code=K7"] {
            XCTAssertThrowsError(try ParticipantAddress.pairingQR(bad), bad)
        }
    }

    func testExpiredCodeShowsExpiredAndSpendsNothing() async throws {
        let rig = try rig()
        laptop.expireCode()
        await rig.model.scan(tunnelA + "/pair#v=1&code=K7QM4TZP")
        XCTAssertEqual(rig.model.screen, .pairingExpired)
        XCTAssertEqual(try rig.vault.read(), CredentialState())
        // Expiry between hello and pair: the pending attempt is cleared, not kept.
        laptop.newPairingCode("K7QM4TZP")
        await rig.model.scan(tunnelA + "/pair#v=1&code=K7QM4TZP")
        XCTAssertEqual(rig.model.screen, .confirmEvent)
        laptop.expireCode()
        await rig.model.confirmPairing()
        XCTAssertEqual(rig.model.screen, .pairingExpired)
        XCTAssertEqual(try rig.vault.read(), CredentialState())
    }

    func testFiveWrongManualCodesLockTheSessionAndTheRightCodeThenShowsExpired() async throws {
        let rig = try rig()
        rig.model.showManual()
        for _ in 0..<5 {
            rig.model.address = tunnelA; rig.model.code = "WRNG-CODE"
            await rig.model.inspectPairing()
            XCTAssertEqual(rig.model.screen, .pairingExpired)
        }
        rig.model.address = tunnelA; rig.model.code = "k7qm-4tzp"
        await rig.model.inspectPairing()
        XCTAssertEqual(rig.model.screen, .pairingExpired, "locked session: a new code is needed")
        XCTAssertNil(try rig.vault.read().active)
        XCTAssertEqual(laptop.paths.filter { $0.hasSuffix("/pair") }, [], "no pair attempt was spent")
    }

    func testLostPairReplyRetriesWithTheSameHashAndPromotesOnce() async throws {
        let rig = try rig()
        await rig.model.scan(tunnelA + "/pair#v=1&code=K7QM4TZP")
        laptop.script([.noConnection, .noConnection, .noConnection])
        await rig.model.confirmPairing()
        XCTAssertEqual(rig.model.screen, .pairingUnavailable)
        XCTAssertNotNil(try rig.vault.read().pending, "same attempt kept for retry")
        await rig.model.retryPairing()
        XCTAssertEqual(rig.model.screen, .setPIN)
        let hashes = laptop.requests.filter { $0.url.path.hasSuffix("/pair") }.compactMap(\.body)
            .map { String(decoding: $0, as: UTF8.self) }
        XCTAssertEqual(hashes.count, 4)
        XCTAssertEqual(Set(hashes).count, 1, "every retry carries the same code and hash")
        XCTAssertEqual(laptop.deviceCount, 1)
    }

    // MARK: Session cache

    func testNamesRefreshOnlyWhenTheHeartbeatReportsANewRosterVersion() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        XCTAssertEqual(try rig.store.rosterVersion(eventId: eventA), laptop.rosterVersion)
        XCTAssertFalse(laptop.paths.contains("/device/v1/heartbeat"), "no cache yet: names fetched directly")

        // Unchanged: one heartbeat, no names download, outbox counts reported.
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        laptop.goOffline(); await rig.model.sendNow(); laptop.addOrigin(URL(string: tunnelA)!.host!)
        var before = laptop.requests.count
        await rig.model.sendNow()
        XCTAssertEqual(Array(laptop.paths.dropFirst(before)), ["/device/v1/heartbeat", "/device/v1/operations"])
        XCTAssertEqual(laptop.heartbeat?.pendingCount, 1)
        XCTAssertNotNil(laptop.heartbeat?.oldestPendingAt)
        XCTAssertEqual(try rig.store.rows(eventId: eventA).count, 3, "cached names kept")

        // The organiser closes check-in: new version, names and window refreshed.
        laptop.closeWindow()
        before = laptop.requests.count
        await rig.model.sendNow()
        XCTAssertEqual(Array(laptop.paths.dropFirst(before)), ["/device/v1/heartbeat", "/device/v1/roster"])
        XCTAssertFalse(try rig.store.isWindowOpen(eventId: eventA))
        XCTAssertEqual(rig.model.screen, .closed)
        XCTAssertEqual(try rig.store.rosterVersion(eventId: eventA), laptop.rosterVersion)

        laptop.rename(riyaToken, to: "Riya Shah-Patel")
        await rig.model.sendNow()
        XCTAssertTrue(try rig.store.rows(eventId: eventA).contains { $0.displayName == "Riya Shah-Patel" })
    }

    func testHeartbeatForAnotherEventPausesAndKeepsTheCache() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let version = try rig.store.rosterVersion(eventId: eventA)
        laptop.script([.json(200, try DeviceProtocol.encode(HeartbeatReply(eventId: eventB, serverTime: nineAM + 60,
            window: openWindow(), rosterVersion: "rv_00000000000000ff")))])
        await rig.model.sendNow()
        XCTAssertEqual(rig.model.screen, .paused)
        XCTAssertEqual(try rig.store.rows(eventId: eventA).count, 3)
        XCTAssertEqual(try rig.store.rosterVersion(eventId: eventA), version)
    }

    func testCheckInsWorkFromTheCacheWhileOfflineAndAcrossRelaunch() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        laptop.goOffline()
        // Relaunch with no connection: the cached names list is the session.
        let relaunched = KioskModel(store: rig.store, credentials: rig.vault,
            pairing: PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.transport),
            pin: OrganiserPIN(vault: FixturePINVault(), clock: rig.clock), transport: rig.transport, fictional: false)
        await relaunched.start()
        XCTAssertEqual(relaunched.screen, .setPIN, "fresh PIN vault in this test; set it")
        await relaunched.setPIN("123456", confirmation: "123456")
        XCTAssertEqual(relaunched.screen, .home)
        XCTAssertEqual(relaunched.statusText, "Saved on this iPad")
        XCTAssertEqual(relaunched.rows.count, 3)
        relaunched.select(relaunched.findRows.first { $0.personToken == riyaToken }!)
        relaunched.saveSelected()
        XCTAssertEqual(relaunched.screen, .done); XCTAssertEqual(relaunched.selected?.status, .savedOnThisIPad)
        await relaunched.sendNow()
        XCTAssertEqual(try rig.store.status(eventId: eventA, personToken: riyaToken), .savedOnThisIPad)
        laptop.addOrigin(URL(string: tunnelA)!.host!)
        await relaunched.sendNow()
        XCTAssertEqual(relaunched.statusText, "Connected")
        XCTAssertEqual(try rig.store.status(eventId: eventA, personToken: riyaToken), .checkedIn)
    }

    func testHandingOverClearsTheCachedSessionIncludingTheRosterVersion() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        rig.model.showPIN(); await rig.model.unlock("123456")
        rig.model.beginHandover(); XCTAssertEqual(rig.model.screen, .handoverConfirm)
        await rig.model.handOver()
        XCTAssertEqual(rig.model.screen, .setup)
        XCTAssertNil(try rig.store.cachedRoster(eventId: eventA))
        XCTAssertNil(try rig.store.rosterVersion(eventId: eventA))
        XCTAssertNil(try rig.vault.read().active)
    }

    // MARK: Re-pair to a new quick-tunnel address

    func testRePairToTheRestartedTunnelDeliversQueuedCheckInsToTheSameEvent() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let firstDevice = try XCTUnwrap(rig.vault.read().active?.deviceId)
        // The desktop app restarts: the old address is gone for good.
        laptop.moveTunnel(to: URL(string: tunnelB)!.host!)
        for token in [alexToken, riyaToken] {
            rig.model.goHome()
            rig.model.select(rig.model.findRows.first { $0.personToken == token }!); rig.model.saveSelected()
            XCTAssertEqual(rig.model.screen, .done)
        }
        await rig.model.sendNow()
        let queued = try [rig.store.opId(eventId: eventA, personToken: alexToken),
                          rig.store.opId(eventId: eventA, personToken: riyaToken)].map { try XCTUnwrap($0) }
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 2)

        // Organiser: Pair again on this iPad's row; iPad: organiser menu → Pair again → scan.
        laptop.newPairingCode("Q4ZT8MK2", pairAgain: firstDevice)
        rig.model.showPIN(); await rig.model.unlock("123456"); rig.model.rePair()
        XCTAssertEqual(rig.model.screen, .setup)
        await pairByQR(rig, tunnelB + "/pair#v=1&code=Q4ZT-8MK2")
        XCTAssertEqual(rig.model.screen, .home)

        XCTAssertEqual(laptop.applied.map(\.opId), queued.map { $0.uuidString.lowercased() })
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA), OutboxSummary(pending: 0, held: 0, acknowledged: 2))
        XCTAssertEqual(laptop.deviceCount, 1, "same device record kept by Pair again")
        XCTAssertEqual(try rig.vault.read().active?.deviceId, firstDevice)
        XCTAssertEqual(try rig.store.pairing(), CheckInStore.Pairing(eventId: eventA, participantAddress: tunnelB))
        // The old credential never went to the new address; the new one never to the old.
        let newCredential = try XCTUnwrap(rig.vault.read().active?.credential)
        XCTAssertNotEqual(newCredential, liveCredential)
        for seen in laptop.requests {
            if seen.url.host == URL(string: tunnelB)!.host! {
                XCTAssertNotEqual(seen.headers["Authorization"], "Bearer " + liveCredential)
            } else {
                XCTAssertNotEqual(seen.headers["Authorization"], "Bearer " + newCredential)
            }
        }
    }

    // MARK: Organiser authority

    /// A participant chooses "Scan a new pairing code" on the PIN screen and
    /// scans a QR for their own HTTPS server, which answers like a laptop for
    /// the same event and echoes the credential hash. Without proof from the
    /// laptop this iPad was paired with, nothing is replaced and no PIN reset
    /// is offered.
    func testAStrangersServerCannotUseTheForgottenPINRouteToTakeOverTheIPad() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        let before = try XCTUnwrap(rig.vault.read().active)
        let stranger = try StubLaptop(origin: URL(string: strangerOrigin)!.host!)
        StubURLProtocol.strangers = [URL(string: strangerOrigin)!.host!: stranger]

        rig.model.showPIN(); rig.model.forgottenPIN(); rig.model.showScanner()
        await rig.model.scan(strangerOrigin + "/pair#v=1&code=K7QM-4TZP")
        if rig.model.screen == .confirmEvent { await rig.model.confirmPairing() }

        XCTAssertNotEqual(rig.model.screen, .setPIN, "no PIN reset for a stranger's server")
        XCTAssertEqual(try rig.vault.read().active, before)
        XCTAssertNil(try rig.vault.read().pending)
        XCTAssertEqual(try rig.store.pairing()?.participantAddress, tunnelA)
        XCTAssertFalse(stranger.paths.contains("/device/v1/pair"), "no pairing attempt at the stranger's server")
        for seen in stranger.requests { XCTAssertNil(seen.headers["Authorization"], "the bearer never goes there") }
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 1)
        rig.model.showPIN(); await rig.model.unlock("123456")
        XCTAssertEqual(rig.model.screen, .organiser, "the organiser's PIN still works")
    }

    /// Forgotten PIN after the laptop restarted on a new quick-tunnel address:
    /// the laptop proves it issued this iPad's key, so its fresh code replaces
    /// the pairing and a new PIN can be chosen. The queue keeps its ids.
    func testForgottenPINWithAFreshCodeFromThePairedLaptopIsProvenAndKeepsTheQueue() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let first = try XCTUnwrap(rig.vault.read().active)
        XCTAssertEqual(first.organiserProofKey, laptop.proofKey(for: first.deviceId), "key stored from the pair reply")
        laptop.moveTunnel(to: URL(string: tunnelB)!.host!)
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        let queued = try XCTUnwrap(rig.store.opId(eventId: eventA, personToken: alexToken))
        laptop.newPairingCode("Q4ZT8MK2", pairAgain: first.deviceId)  // Pair again for this iPad

        rig.model.showPIN(); rig.model.forgottenPIN(); rig.model.showScanner()
        await rig.model.scan(tunnelB + "/pair#v=1&code=Q4ZT-8MK2")
        XCTAssertEqual(rig.model.screen, .confirmEvent)
        await rig.model.confirmPairing()
        XCTAssertEqual(rig.model.screen, .setPIN)
        await rig.model.setPIN("654321", confirmation: "654321")
        XCTAssertEqual(rig.model.screen, .home)

        XCTAssertEqual(laptop.applied.map(\.opId), [queued.uuidString.lowercased()])
        XCTAssertEqual(try rig.store.pairing()?.participantAddress, tunnelB)
        let hello = try XCTUnwrap(laptop.requests.last { $0.url.host == URL(string: tunnelB)!.host! && $0.url.path.hasSuffix("/hello") })
        let asked = try JSONSerialization.jsonObject(with: XCTUnwrap(hello.body)) as? [String: Any]
        XCTAssertEqual((asked?["organiserProof"] as? [String: Any])?["deviceId"] as? String, first.deviceId)
        for seen in laptop.requests where seen.url.host == URL(string: tunnelB)!.host! {
            XCTAssertNotEqual(seen.headers["Authorization"], "Bearer " + first.credential, "old bearer stays at its own address")
        }
        rig.model.showPIN(); await rig.model.unlock("654321")
        XCTAssertEqual(rig.model.screen, .organiser)
    }

    /// Forgotten PIN: the laptop proves itself for this iPad, but its pair
    /// reply names another device (a code targeted at a different iPad). The
    /// proof vouched only for this device, so the reply is refused: the vault
    /// is as it was, the PIN is asked for and the queued check-in stays.
    func testAProvenRePairWhoseReplyNamesAnotherDeviceIsRefused() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let before = try rig.vault.read()
        let first = try XCTUnwrap(before.active)
        laptop.moveTunnel(to: URL(string: tunnelB)!.host!)
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        let queued = try XCTUnwrap(rig.store.opId(eventId: eventA, personToken: alexToken))
        laptop.newPairingCode("Q4ZT8MK2", pairAgain: "dev_fixture_ipad9")  // another iPad

        rig.model.showPIN(); rig.model.forgottenPIN(); rig.model.showScanner()
        await rig.model.scan(tunnelB + "/pair#v=1&code=Q4ZT-8MK2")
        XCTAssertEqual(rig.model.screen, .confirmEvent, "the laptop did prove itself")
        await rig.model.confirmPairing()

        XCTAssertTrue(laptop.paths.contains("/device/v1/pair"))
        XCTAssertEqual(rig.model.screen, .pin, "no PIN reset for another device's code")
        XCTAssertEqual(rig.model.message, "This code couldn't be confirmed by the laptop this iPad is paired with. Enter the organiser PIN, then choose Pair again.")
        XCTAssertEqual(try rig.vault.read(), before, "nothing from the reply is kept")
        XCTAssertEqual(try rig.store.pairing()?.participantAddress, tunnelA)
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 1)
        XCTAssertEqual(try rig.store.opId(eventId: eventA, personToken: alexToken), queued)
        rig.model.showPIN(); await rig.model.unlock("123456")
        XCTAssertEqual(rig.model.screen, .organiser, "the organiser's PIN still works")

        // The core seam directly: a proven offer, then a reply for another device.
        laptop.newPairingCode("R8XK2MPQ", pairAgain: "dev_fixture_ipad9")
        let coordinator = PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.transport)
        let offer = try await coordinator.inspect(address: tunnelB, code: "R8XK2MPQ")
        try await coordinator.begin(address: tunnelB, code: "R8XK2MPQ", confirmed: offer)
        XCTAssertEqual(try rig.vault.read().pending?.authorisation, .organiserProof(deviceId: first.deviceId))
        do { _ = try await coordinator.retry(); XCTFail("another device's reply accepted") }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        XCTAssertEqual(try rig.vault.read(), before)
    }

    /// A pairing from a laptop that issued no key can only be replaced with
    /// the PIN; without a key the forgotten-PIN route sends nothing anywhere.
    func testWithoutAProofKeyOnlyThePINCanReplaceThePairing() async throws {
        laptop.stopIssuingProofKeys()
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let first = try XCTUnwrap(rig.vault.read().active)
        XCTAssertNil(first.organiserProofKey)
        laptop.newPairingCode("Q4ZT8MK2")
        let before = laptop.requests.count
        rig.model.showPIN(); rig.model.forgottenPIN(); rig.model.showScanner()
        await rig.model.scan(tunnelA + "/pair#v=1&code=Q4ZT-8MK2")
        XCTAssertEqual(rig.model.screen, .pin)
        XCTAssertEqual(rig.model.message, "This code couldn't be confirmed by the laptop this iPad is paired with. Enter the organiser PIN, then choose Pair again.")
        XCTAssertEqual(laptop.requests.count, before)
        XCTAssertEqual(try rig.vault.read().active, first)

        await rig.model.unlock("123456"); rig.model.rePair()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=Q4ZT-8MK2")
        XCTAssertEqual(rig.model.screen, .home)
        XCTAssertNotEqual(try rig.vault.read().active?.credential, first.credential)
    }

    /// Relay attack: a participant sees a fresh code on the laptop screen and
    /// puts it in a QR for their own server. That server relays the iPad's
    /// hello (nonce included) to the real laptop, which answers with a
    /// genuine proof, and would then fabricate a pair success for this
    /// iPad's device id. The proof was made for the laptop's address, not the
    /// one the iPad scanned, so it is refused and nothing is written.
    func testARelayedProofFromTheRealLaptopIsRefusedAtAnotherAddress() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        let before = try rig.vault.read()
        let active = try XCTUnwrap(before.active)
        laptop.newPairingCode("Q4ZT8MK2")
        let relay = try StubLaptop(origin: URL(string: strangerOrigin)!.host!)
        relay.relayHello(to: laptop, at: tunnelA)
        relay.newPairingCode("Q4ZT8MK2", pairAgain: active.deviceId)  // fabricated success for this iPad
        StubURLProtocol.strangers = [URL(string: strangerOrigin)!.host!: relay]

        rig.model.showPIN(); rig.model.forgottenPIN(); rig.model.showScanner()
        await rig.model.scan(strangerOrigin + "/pair#v=1&code=Q4ZT-8MK2")
        if rig.model.screen == .confirmEvent { await rig.model.confirmPairing() }

        // The real laptop did answer the relayed hello with a proof.
        let relayed = try XCTUnwrap(laptop.requests.last { $0.url.path.hasSuffix("/hello") })
        let asked = try JSONSerialization.jsonObject(with: XCTUnwrap(relayed.body)) as? [String: Any]
        XCTAssertEqual((asked?["organiserProof"] as? [String: Any])?["deviceId"] as? String, active.deviceId)
        XCTAssertEqual(rig.model.screen, .pin, "no PIN reset through a relay")
        XCTAssertEqual(try rig.vault.read(), before, "nothing written")
        XCTAssertEqual(try rig.store.pairing()?.participantAddress, tunnelA)
        XCTAssertFalse(relay.paths.contains("/device/v1/pair"), "no pairing attempt at the relay")
        for seen in relay.requests { XCTAssertNil(seen.headers["Authorization"], "the bearer never goes there") }
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 1)

        // The core seam directly: the relayed proof never authorises begin().
        let coordinator = PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.transport)
        do { _ = try await coordinator.inspect(address: strangerOrigin, code: "Q4ZT8MK2"); XCTFail("relay proved") }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        do { try await coordinator.begin(address: strangerOrigin, code: "Q4ZT8MK2", confirmed: active.offer); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        XCTAssertEqual(try rig.vault.read(), before)
        // The same code at the laptop's own address still proves itself.
        _ = try await coordinator.inspect(address: tunnelA, code: "Q4ZT8MK2")
    }

    /// The core seam: a proof made with any other key, or none, is refused
    /// before a pending attempt is written, even for the same event.
    func testCoordinatorRefusesAWrongOrMissingProofWithoutWritingAnAttempt() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let state = try rig.vault.read()
        let stranger = try StubLaptop(origin: URL(string: strangerOrigin)!.host!)
        StubURLProtocol.strangers = [URL(string: strangerOrigin)!.host!: stranger]
        let coordinator = PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.transport)
        do { _ = try await coordinator.inspect(address: strangerOrigin, code: "K7QM4TZP"); XCTFail("stranger proved") }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        stranger.stopIssuingProofKeys()
        do { _ = try await coordinator.inspect(address: strangerOrigin, code: "K7QM4TZP"); XCTFail("no proof") }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        let offer = try XCTUnwrap(state.active?.offer)
        do { try await coordinator.begin(address: strangerOrigin, code: "K7QM4TZP", confirmed: offer); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        XCTAssertEqual(try rig.vault.read(), state)
        // A proven offer authorises only its own address and code.
        laptop.newPairingCode("Q4ZT8MK2")
        _ = try await coordinator.inspect(address: tunnelA, code: "Q4ZT8MK2")
        do { try await coordinator.begin(address: strangerOrigin, code: "Q4ZT8MK2", confirmed: offer); XCTFail() }
        catch { XCTAssertEqual(error as? PairingError, .organiserAuthorityRequired) }
        XCTAssertEqual(try rig.vault.read(), state)
    }

    // MARK: Stranded pairing attempt

    /// The pair reply is lost, then the laptop restarts on a new address. The
    /// organiser replaces the saved attempt with a new code after the PIN;
    /// the current pairing and the queued check-ins (same ids) survive.
    func testAStrandedAttemptIsReplacedWithANewCodeAfterThePIN() async throws {
        let rig = try rig(credentials: [liveCredential, "dc_" + String(repeating: "b", count: 43),
                                        "dc_" + String(repeating: "c", count: 43)])
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        let first = try XCTUnwrap(rig.vault.read().active)
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        let queued = try XCTUnwrap(rig.store.opId(eventId: eventA, personToken: alexToken))
        // Organiser: Pair again; the reply never arrives.
        laptop.newPairingCode("R8XK2MPQ", pairAgain: first.deviceId)
        rig.model.showPIN(); await rig.model.unlock("123456"); rig.model.rePair()
        await rig.model.scan(tunnelA + "/pair#v=1&code=R8XK-2MPQ")
        laptop.script([.noConnection, .noConnection, .noConnection])
        await rig.model.confirmPairing()
        XCTAssertNotNil(try rig.vault.read().pending)
        // The laptop restarts on a new address; the iPad app is relaunched.
        laptop.moveTunnel(to: URL(string: tunnelB)!.host!)
        let relaunched = KioskModel(store: rig.store, credentials: rig.vault,
            pairing: PairingCoordinator(vault: rig.vault, store: rig.store, transport: rig.transport),
            pin: OrganiserPIN(vault: rig.pins, clock: rig.clock), transport: rig.transport, fictional: false)
        await relaunched.start()
        XCTAssertEqual(relaunched.screen, .pairingUnavailable)
        await relaunched.retryPairing()
        XCTAssertEqual(relaunched.screen, .pairingUnavailable, "the old address is gone")

        // Without the PIN nothing changes.
        relaunched.useNewPairingCode()
        XCTAssertEqual(relaunched.screen, .pin)
        XCTAssertEqual(relaunched.message, "Enter the organiser PIN to use a new pairing code.")
        await relaunched.unlock("000000")
        XCTAssertEqual(relaunched.screen, .pin)
        relaunched.goHome(); XCTAssertEqual(relaunched.screen, .home)
        XCTAssertEqual(try rig.vault.read().active, first)

        // With the PIN: scan the new code, the saved attempt is replaced.
        try await reachPairingUnavailable(relaunched)
        relaunched.useNewPairingCode(); await relaunched.unlock("123456")
        XCTAssertEqual(relaunched.screen, .setup)
        laptop.newPairingCode("Q4ZT8MK2", pairAgain: first.deviceId)
        await relaunched.scan(tunnelB + "/pair#v=1&code=Q4ZT-8MK2")
        XCTAssertEqual(relaunched.screen, .confirmEvent)
        XCTAssertEqual(try rig.vault.read().active, first, "current pairing kept until the new one succeeds")
        await relaunched.confirmPairing()
        XCTAssertEqual(relaunched.screen, .setPIN)
        await relaunched.setPIN("123456", confirmation: "123456")
        XCTAssertEqual(relaunched.screen, .home)
        XCTAssertNil(try rig.vault.read().pending)
        XCTAssertEqual(try rig.vault.read().active?.deviceId, first.deviceId)
        XCTAssertEqual(laptop.applied.map(\.opId), [queued.uuidString.lowercased()])
        XCTAssertEqual(try rig.store.pairing()?.participantAddress, tunnelB)
    }

    private func reachPairingUnavailable(_ model: KioskModel) async throws {
        await model.start()
        XCTAssertEqual(model.screen, .pairingUnavailable)
    }

    // MARK: Window and rate limits

    /// The heartbeat says check-in has closed, then fetching the names fails:
    /// the closed window is kept and shown at once.
    func testAClosedWindowFromTheHeartbeatCountsWhenFetchingNamesFails() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        XCTAssertEqual(rig.model.screen, .home)
        let stored = try DeviceProtocol.decode(RosterSnapshot.self, from: contractFixture("roster.example.json")).window
        let closed = WindowInfo(state: .closed, revision: stored.revision + 1, openedAt: stored.openedAt, closesAt: stored.closesAt)
        laptop.script([.json(200, try DeviceProtocol.encode(HeartbeatReply(eventId: eventA, serverTime: nineAM + 3600,
                                                                          window: closed, rosterVersion: "rv_00000000000000ff"))),
                       .html(502), .html(502), .html(502)])
        await rig.model.sendNow()
        XCTAssertFalse(try rig.store.isWindowOpen(eventId: eventA))
        XCTAssertEqual(rig.model.screen, .closed)
        XCTAssertEqual(try rig.store.rows(eventId: eventA).count, 3, "cached names kept")
        XCTAssertThrowsError(try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken))
    }

    /// 429 with Retry-After: every request to that laptop, automatic or a
    /// tap, waits on the iPad until the deadline; then sending resumes.
    func testRetryAfterHoldsEveryRequestToTheLaptopUntilItPasses() async throws {
        let rig = try rig()
        await pairByQR(rig, tunnelA + "/pair#v=1&code=K7QM4TZP")
        _ = try rig.store.recordCheckIn(eventId: eventA, personToken: alexToken)
        laptop.script([.rateLimited(retryAfter: "120")])
        await rig.model.sendNow()
        XCTAssertEqual(rig.model.message, "The laptop asked this iPad to wait a minute. The check-ins are still saved on this iPad.")
        let before = laptop.requests.count
        await rig.model.sendNow()                                    // manual Send now
        let report = await rig.store.deliverPending(eventId: eventA, via: rig.transport)  // automatic
        XCTAssertEqual(report.stop, .transport(.rateLimited))
        rig.uptime.advance(119)
        await rig.model.sendNow()
        XCTAssertEqual(laptop.requests.count, before, "nothing reached the laptop before Retry-After")
        rig.uptime.advance(2)
        await rig.model.sendNow()
        XCTAssertEqual(rig.model.statusText, "Connected")
        _ = await rig.store.deliverPending(eventId: eventA, via: rig.transport)
        XCTAssertEqual(try rig.store.outboxSummary(eventId: eventA).pending, 0)
        XCTAssertTrue(rig.sleeps.delays.isEmpty, "a 429 is never retried in the backoff loop")
    }

    func testRetryAfterParsingAndLimits() throws {
        let now = isoDate("2026-10-14T09:00:00Z")
        XCTAssertEqual(RetryAfterGate.parse("60"), 60)
        XCTAssertEqual(RetryAfterGate.parse(" 5 "), 5)
        XCTAssertEqual(RetryAfterGate.parse("Wed, 14 Oct 2026 09:01:30 GMT", now: now), 90)
        XCTAssertEqual(RetryAfterGate.parse("Wed, 14 Oct 2026 08:59:00 GMT", now: now), 0)
        XCTAssertEqual(RetryAfterGate.parse("000000000120"), 120, "every digit counts, leading zeros too")
        XCTAssertEqual(RetryAfterGate.parse("0000000000000000000000000000045"), 45)
        XCTAssertEqual(RetryAfterGate.parse("1234567890"), RetryAfterGate.maximumDelay, "not truncated to 9 digits")
        XCTAssertEqual(RetryAfterGate.parse("600"), 600)
        XCTAssertEqual(RetryAfterGate.parse("601"), RetryAfterGate.maximumDelay)
        XCTAssertEqual(RetryAfterGate.parse(String(repeating: "9", count: 400)), RetryAfterGate.maximumDelay,
                       "saturates instead of overflowing")
        XCTAssertEqual(RetryAfterGate.parse("0"), 0)
        for bad in [nil, "", "soon", "-5", "1.5", "+5", "1 2"] {
            XCTAssertNil(RetryAfterGate.parse(bad), String(describing: bad))
        }
        let uptime = Uptime(), gate = RetryAfterGate(now: { uptime.now })
        let url = URL(string: tunnelA + "/device/v1/operations")!
        gate.hold(url, retryAfter: 1_000_000)
        XCTAssertEqual(gate.remaining(for: url), RetryAfterGate.maximumDelay)
        XCTAssertNil(gate.remaining(for: URL(string: tunnelB + "/device/v1/operations")!), "per laptop address")
        let other = RetryAfterGate(now: { uptime.now })
        other.hold(url, retryAfter: nil)
        XCTAssertEqual(other.remaining(for: url), RetryAfterGate.defaultDelay)
    }
}

/// Deterministic fictional credentials, one per pairing.
final class CredentialQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String]
    init(_ values: [String]) { self.values = values }
    func next() -> String { lock.lock(); defer { lock.unlock() }; return values.isEmpty ? "invalid" : values.removeFirst() }
}
