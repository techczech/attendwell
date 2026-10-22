import Foundation
import XCTest
import WorkshopCheckInCore
import WorkshopCheckInUI

@MainActor
final class DemoTests: XCTestCase {
    func testDemoChecksANameInWithNothingSentOutsideAndNoOrganiserAccess() async throws {
        let demo = try DemoSession(); defer { demo.end() }
        let model = demo.model
        await model.start()
        XCTAssertEqual(model.screen, .home); XCTAssertTrue(model.isDemo)
        XCTAssertEqual(model.offer?.eventName, "Demo workshop")
        XCTAssertEqual(model.findRows.count, DemoSession.names.count)
        model.select(model.findRows[0]); XCTAssertEqual(model.screen, .confirm)
        model.saveSelected(); XCTAssertEqual(model.screen, .done)
        await model.sendNow()
        XCTAssertEqual(model.selected?.status, .checkedIn)
        XCTAssertEqual(model.doneRows.count, 1)
        model.goHome()
        model.showPIN(); XCTAssertEqual(model.screen, .home, "the organiser PIN screen is unreachable in the demo")
    }

    func testLeavingTheDemoDeletesItsStorageAndLeavesNoSavedSession() async throws {
        let demo = try DemoSession()
        await demo.model.start(); demo.model.select(demo.model.findRows[1]); demo.model.saveSelected()
        XCTAssertTrue(demo.storageExists)
        demo.end()
        XCTAssertFalse(demo.storageExists)
        // A fresh live-style session on an empty vault opens on set-up: nothing carried over.
        let dir = try TempDirectory()
        let store = try CheckInStore(fileURL: dir.storeFile)
        let vault = FixtureCredentialVault()
        let offer = PairingOffer(eventId: "e", eventCode: "C", eventName: "x", eventDate: "d", deviceLabel: "l")
        let model = KioskModel(store: store, credentials: vault,
            pairing: PairingCoordinator(vault: vault, store: store, transport: FixturePairingTransport(offer: offer)),
            pin: OrganiserPIN(vault: FixturePINVault()),
            transport: FictionalKioskTransport(host: FixtureHost(eventId: "e", eventCode: "C", people: [],
                window: WindowInfo(state: .open, revision: 1, openedAt: Date(), closesAt: nil), now: { Date() })),
            fictional: false)
        await model.start()
        XCTAssertEqual(model.screen, .setup); XCTAssertNil(try vault.read().active)
    }
}
