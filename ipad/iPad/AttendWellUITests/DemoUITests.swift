import XCTest

/// Drives "Try a demo" on the real app: check a made-up name in, leave, land on set-up.
/// Also records the App Store screenshots (portrait and landscape) as attachments.
/// Needs no laptop, no environment and no network.
final class DemoUITests: XCTestCase {
    override func setUp() { continueAfterFailure = false }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func runDemo(_ orientation: UIDeviceOrientation, _ label: String) {
        XCUIDevice.shared.orientation = orientation
        let app = XCUIApplication()
        app.launch()
        let setup = app.buttons["Connections"]
        XCTAssertTrue(setup.waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["Try a demo"].exists)
        shot("\(label)-1-setup")

        setup.tap()
        let demo = app.buttons["Try a demo"]
        XCTAssertTrue(demo.waitForExistence(timeout: 10))
        demo.tap()
        XCTAssertTrue(app.staticTexts["Demo — names are made up and nothing is sent anywhere."].waitForExistence(timeout: 10))
        let ada = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ada Example'")).firstMatch
        XCTAssertTrue(ada.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Organiser"].exists, "the demo has no organiser access")
        shot("\(label)-2-demo-names")

        ada.tap()
        let yes = app.buttons["Yes, check me in"]
        XCTAssertTrue(yes.waitForExistence(timeout: 10))
        shot("\(label)-3-demo-confirm")
        yes.tap()
        XCTAssertTrue(app.staticTexts["You're checked in, Ada Example."].waitForExistence(timeout: 10))
        shot("\(label)-4-demo-checked-in")

        // Back on the list, the name sits under "Already done"; then leave.
        let leave = app.buttons["Leave demo"]
        XCTAssertTrue(leave.waitForExistence(timeout: 10))
        leave.tap()
        XCTAssertTrue(app.buttons["Connections"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Demo — names are made up and nothing is sent anywhere."].exists)

        // Nothing carried over: relaunching still opens on set-up, not on a saved session.
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["Connections"].waitForExistence(timeout: 20))
    }

    #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
    func testNearbyKioskReleaseScreens() {
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        func launch(_ fixture: String) {
            app.launchArguments = [fixture]
            app.launch()
        }
        let connections = app.buttons["Connections"]

        launch("--startup-setup")
        XCTAssertTrue(connections.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Open Connections to set up check-in."].exists)
        XCTAssertFalse(app.buttons["Connect Mac locally"].exists)
        shot("01-not-yet-connected")

        launch("--startup-nearby-open")
        XCTAssertTrue(app.staticTexts["Spring Workshop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["Search your name"].exists)
        XCTAssertFalse(app.buttons["Organiser"].exists)
        XCTAssertFalse(app.buttons["Connect Mac locally"].exists)
        let alex = app.buttons["Alex Morgan, Not checked in"]
        XCTAssertTrue(alex.exists)
        shot("02-connected-with-names")

        alex.tap()
        XCTAssertTrue(app.staticTexts["Is this you?"].waitForExistence(timeout: 10))
        shot("03-confirm")
        app.buttons["Yes, check me in"].tap()
        let saved = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Saved on this iPad, Alex Morgan.")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 2))
        shot("04-saved")
        saved.tap()

        connections.tap()
        let local = app.buttons["Connect Mac locally"]
        XCTAssertTrue(local.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["nearby-connection"].exists)
        XCTAssertTrue(app.staticTexts["Unsent check-ins: 1"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "AttendWell 1.0.1 (")).firstMatch.exists)
        XCTAssertTrue(app.buttons["Connect computer over internet"].exists)
        XCTAssertTrue(app.buttons["Enter local code"].exists)
        XCTAssertTrue(app.buttons["Try a demo"].exists)
        shot("05-connections")
        app.buttons["Enter local code"].tap()
        XCTAssertTrue(app.textFields["8-character code"].waitForExistence(timeout: 10))
        app.buttons["Back"].tap()
        app.buttons["Connect computer over internet"].tap()
        XCTAssertTrue(app.buttons["Enter a code instead"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Back to local check-in"].exists)

        launch("--startup-closed")
        XCTAssertTrue(app.staticTexts["Check-in is closed"].waitForExistence(timeout: 10))
        XCTAssertTrue(connections.exists)
        XCTAssertFalse(app.buttons["Organiser"].exists)
        shot("06-closed")
    }
    #endif

    func testDemoPortrait() { runDemo(.portrait, "portrait") }
    func testDemoLandscape() { runDemo(.landscapeLeft, "landscape") }
}
