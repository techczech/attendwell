import Foundation
import XCTest
import WorkshopCheckInCore
import WorkshopCheckInUI

@MainActor
final class KioskJourneyTests: XCTestCase {
    func testHandoverAndRePairWaitForAnInFlightRosterSoItCannotRestoreRemovedNames() async throws {
        let dir = try TempDirectory(); let clock = FakeClock()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/k3v9")
        let offer = PairingOffer(eventId: eventA, eventCode: "7Q2M", eventName: "Spring Workshop", eventDate: "14 October 2026", deviceLabel: "iPad 2")
        let vault = FixtureCredentialVault(CredentialState(active: ActiveCredential(credential: "dc_fixture", address: "https://checkin.example.org/s/k3v9", offer: offer, deviceId: "dev_fixture")))
        let pin = OrganiserPIN(vault: FixturePINVault(), clock: clock); try await pin.set("123456", confirmation: "123456")
        let gate = Gate()
        let model = KioskModel(store: store, credentials: vault,
            pairing: PairingCoordinator(vault: vault, store: store, transport: FixturePairingTransport(offer: offer)),
            pin: pin, transport: GatedKioskTransport(host: makeHost(clock: clock), gate: gate))
        let start = Task { await model.start() }
        await gate.waitForArrivals(1)
        model.showPIN(); await model.unlock("123456")
        XCTAssertEqual(model.screen, .organiser)
        model.beginHandover(); XCTAssertEqual(model.screen, .organiser)
        model.rePair(); XCTAssertEqual(model.screen, .organiser)
        XCTAssertNotNil(try store.pairing())
        await gate.open(); await start.value
        model.beginHandover(); XCTAssertEqual(model.screen, .handoverConfirm)
        await model.handOver()
        XCTAssertNil(try store.pairing()); XCTAssertTrue(try store.rows(eventId: eventA).isEmpty)
        XCTAssertNil(try vault.read().active); XCTAssertEqual(model.screen, .setup)
    }

    func testSlowForegroundSendingDoesNotBlockDurableParticipantSave() async throws {
        let dir = try TempDirectory(); let clock = FakeClock()
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/k3v9")
        let offer = PairingOffer(eventId: eventA, eventCode: "7Q2M", eventName: "Spring Workshop", eventDate: "14 October 2026", deviceLabel: "iPad 2")
        let vault = FixtureCredentialVault(CredentialState(active: ActiveCredential(credential: "dc_fixture", address: "https://checkin.example.org/s/k3v9", offer: offer, deviceId: "dev_fixture")))
        let pin = OrganiserPIN(vault: FixturePINVault(), clock: clock); try await pin.set("123456", confirmation: "123456")
        let gate = Gate(), host = makeHost(clock: clock)
        let transport = GatedKioskTransport(host: host, gate: gate)
        let model = KioskModel(store: store, credentials: vault,
            pairing: PairingCoordinator(vault: vault, store: store, transport: FixturePairingTransport(offer: offer)),
            pin: pin, transport: transport)
        let start = Task { await model.start() }
        await gate.waitForArrivals(1)
        XCTAssertTrue(model.sending); XCTAssertEqual(model.screen, .home)
        model.select(model.findRows.first!); model.saveSelected()
        XCTAssertEqual(model.screen, .done); XCTAssertEqual(model.selected?.status, .savedOnThisIPad)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
        await gate.open(); await start.value
        XCTAssertEqual(model.selected?.status, .checkedIn)
    }
    private func fixture(_ dir: TempDirectory, clock: FakeClock, mode: FictionalKioskTransport.Mode = .offline,
                         credentialVault: (any CredentialVault)? = nil) async throws
        -> (KioskModel, CheckInStore, FictionalKioskTransport, OrganiserPIN) {
        let store = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        _ = try store.applyRoster(roster()); try store.setPairing(eventId: eventA, participantAddress: "https://checkin.example.org/s/k3v9")
        let offer = PairingOffer(eventId: eventA, eventCode: "7Q2M", eventName: "Spring Workshop", eventDate: "14 October 2026", deviceLabel: "iPad 2")
        let state = CredentialState(active: ActiveCredential(credential: "dc_fixture",
            address: "https://checkin.example.org/s/k3v9", offer: offer, deviceId: "dev_fixture"))
        let vault: any CredentialVault = credentialVault ?? FixtureCredentialVault(state)
        if credentialVault != nil { try vault.write(state) }
        let pin = OrganiserPIN(vault: FixturePINVault(), clock: clock)
        try await pin.set("123456", confirmation: "123456")
        let transport = FictionalKioskTransport(host: makeHost(clock: clock))
        await transport.setMode(mode)
        let pairing = PairingCoordinator(vault: vault, store: store, transport: FixturePairingTransport(offer: offer))
        let model = KioskModel(store: store, credentials: vault, pairing: pairing, pin: pin, transport: transport)
        await model.start()
        return (model, store, transport, pin)
    }

    func testSavedScreenAndMoveDownFollowDiskCommitAndOnlyAckSaysCheckedIn() async throws {
        let dir = try TempDirectory(); let clock = FakeClock()
        let (model, store, transport, _) = try await fixture(dir, clock: clock)
        model.select(model.findRows.first { $0.personToken == alex.personToken }!)
        model.saveSelected()
        XCTAssertEqual(model.screen, .done); XCTAssertEqual(model.selected?.status, .savedOnThisIPad)
        XCTAssertFalse(model.findRows.contains { $0.personToken == alex.personToken })
        XCTAssertEqual(model.doneRows.first { $0.personToken == alex.personToken }?.status, .savedOnThisIPad)
        let disk = try CheckInStore(fileURL: dir.storeFile, clock: clock)
        XCTAssertEqual(try disk.status(eventId: eventA, personToken: alex.personToken), .savedOnThisIPad)
        let op = try store.opId(eventId: eventA, personToken: alex.personToken)
        await transport.setMode(.connected); await model.sendNow()
        XCTAssertEqual(model.selected?.status, .checkedIn); XCTAssertEqual(try store.opId(eventId: eventA, personToken: alex.personToken), op)
        await transport.setMode(.offline); await model.sendNow()
        XCTAssertEqual(model.selected?.status, .checkedIn)
    }

    func testDiskFailureNeverShowsSavedOrMovesName() async throws {
        let dir = try TempDirectory(); let (model, store, _, _) = try await fixture(dir, clock: FakeClock())
        rawSQL(dir.storeFile, "CREATE TRIGGER fail_save BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'fixture disk fault'); END;")
        model.select(model.findRows.first!)
        let token = model.selected!.personToken
        model.saveSelected()
        XCTAssertEqual(model.screen, .commitFailed)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: token), .notCheckedIn)
        XCTAssertTrue(model.findRows.contains { $0.personToken == token })
        rawSQL(dir.storeFile, "DROP TRIGGER fail_save;"); model.saveSelected()
        XCTAssertEqual(model.screen, .done)
    }

    func testCommittedSaveKeepsItsNameAndStatusWhenTheFollowingRosterReadHasNoPerson() async throws {
        let dir = try TempDirectory(); let (model, store, _, _) = try await fixture(dir, clock: FakeClock())
        let row = model.findRows.first!
        // Real SQLite fault injection: the successful insert's trigger removes
        // the roster row, so post-commit lookup cannot supply a selected name.
        rawSQL(dir.storeFile, "CREATE TRIGGER fixture_roster_change AFTER INSERT ON operations BEGIN DELETE FROM people WHERE person_token = NEW.person_token; END;")
        model.select(row); model.saveSelected()
        XCTAssertEqual(model.screen, .done)
        XCTAssertEqual(model.selected?.displayName, row.displayName)
        XCTAssertEqual(model.selected?.status, .savedOnThisIPad)
        XCTAssertEqual(try store.status(eventId: eventA, personToken: row.personToken), .savedOnThisIPad)
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
    }

    func testHandoverRequiresUnlockAndSuccessfulFileSaveWithCurrentOperations() async throws {
        let dir = try TempDirectory(); let (model, store, _, _) = try await fixture(dir, clock: FakeClock())
        model.select(model.findRows.first!); model.saveSelected(); model.goHome()
        model.prepareRecovery(); XCTAssertNil(model.recovery)
        model.beginHandover(); XCTAssertEqual(model.screen, .home)
        model.showPIN(); await model.unlock("123456"); XCTAssertTrue(model.unlocked)
        model.beginHandover(); XCTAssertEqual(model.screen, .handover)
        model.prepareRecovery(fromHandover: true)
        XCTAssertNotNil(model.recovery)
        // Merely creating/exporting bytes cannot authorise removal.
        XCTAssertFalse(try store.removalPreview(eventId: eventA).unsentCoveredBySavedRecovery)
        XCTAssertTrue(DeviceProtocol.privacyViolations(in: model.recovery!.data).isEmpty)
        model.recoverySaved(); model.continueAfterRecovery(); XCTAssertEqual(model.screen, .handoverConfirm)
        // A new check-in invalidates the preview and coverage.
        _ = try store.recordCheckIn(eventId: eventA, personToken: riya.personToken)
        await model.handOver()
        XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 2)
        XCTAssertNotNil(try store.pairing())
        model.prepareRecovery(fromHandover: true); model.recoverySaved(); model.continueAfterRecovery()
        await model.handOver(); XCTAssertEqual(model.screen, .setup); XCTAssertNil(try store.pairing())
    }

    func testClosedReopenAndRevokeKeepPendingRows() async throws {
        let dir = try TempDirectory(); let clock = FakeClock()
        let (model, store, transport, _) = try await fixture(dir, clock: clock)
        model.select(model.findRows.first!); model.saveSelected(); model.goHome()
        let token = alex.personToken; let op = try store.opId(eventId: eventA, personToken: token)
        await transport.host.close(); await transport.setMode(.connected); await model.sendNow(); model.goHome()
        XCTAssertEqual(model.screen, .closed); XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
        await transport.setMode(.revoked); await model.sendNow()
        XCTAssertEqual(model.screen, .paused); XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 1)
        XCTAssertEqual(try store.opId(eventId: eventA, personToken: token), op)
        // Store's established same-event reopen remains safe independently of
        // the revoked UI; actual re-pair host integration is still provisional.
        await transport.host.reopen(closesAt: nil); await transport.setMode(.connected)
        _ = try store.applyRoster(try await transport.fetchRoster())
        let report = await store.deliverPending(eventId: eventA, via: transport)
        XCTAssertEqual(report.stop, .drained); XCTAssertEqual(try store.outboxSummary(eventId: eventA).pending, 0)
    }

    func testBackgroundLocksOrganiserAndRecoveryActions() async throws {
        let dir = try TempDirectory(); let (model, _, _, _) = try await fixture(dir, clock: FakeClock())
        model.showPIN(); await model.unlock("123456"); XCTAssertTrue(model.unlocked)
        model.suspend(); XCTAssertFalse(model.unlocked); XCTAssertEqual(model.screen, .pin)
        model.prepareRecovery(); XCTAssertNil(model.recovery)
    }

    func testFailedKeychainCleanupAfterHandoverCannotRestoreRemovedNames() async throws {
        let dir = try TempDirectory(); let vault = CleanupFailingVault()
        let (model, store, transport, _) = try await fixture(dir, clock: FakeClock(), credentialVault: vault)
        model.showPIN(); await model.unlock("123456"); model.beginHandover()
        XCTAssertEqual(model.screen, .handoverConfirm)
        await model.handOver()
        XCTAssertEqual(model.screen, .paused); XCTAssertNil(model.active); XCTAssertTrue(model.rows.isEmpty)
        XCTAssertNil(try store.pairing()); XCTAssertNotNil(try vault.read().active)
        await transport.setMode(.connected); await model.sendNow()
        XCTAssertTrue(try store.rows(eventId: eventA).isEmpty); XCTAssertNil(try store.pairing())
        XCTAssertFalse(model.unlocked)
    }

    func testPINLockoutSurvivesRelaunchAndWallClockChangeAndReboot() async throws {
        let clock = FakeClock(); let vault = FixturePINVault()
        let first = OrganiserPIN(vault: vault, clock: clock)
        try await first.set("123456", confirmation: "123456")
        for _ in 0..<5 { do { try await first.unlock("000000"); XCTFail() } catch {} }
        let relaunched = OrganiserPIN(vault: vault, clock: clock)
        clock.setWall(nineAM + 86400)
        do { try await relaunched.unlock("123456"); XCTFail() } catch { XCTAssertEqual(error as? PINError, .locked) }
        clock.reboot(wallAfter: nineAM + 86400)
        do { try await relaunched.unlock("123456"); XCTFail() } catch { XCTAssertEqual(error as? PINError, .locked) }
        clock.advance(30); try await relaunched.unlock("123456")
        XCTAssertNotEqual(try vault.readPIN()?.hash, "123456")
        XCTAssertEqual(try vault.readPIN()?.failures, 0)
    }
}

private struct GatedKioskTransport: KioskTransport {
    let host: FixtureHost
    let gate: Gate
    func fetchRoster() async throws -> RosterSnapshot { await gate.pass(); return await host.roster() }
    func submitOperations(eventId: String, body: Data) async throws -> Data {
        try await host.submitOperations(eventId: eventId, body: body)
    }
}

private final class CleanupFailingVault: CredentialVault, @unchecked Sendable {
    private let backing = FixtureCredentialVault()
    func read() throws -> CredentialState { try backing.read() }
    func write(_ state: CredentialState) throws {
        if state.active == nil && state.pending == nil { throw PairingError.keychain(-1) }
        try backing.write(state)
    }
}
