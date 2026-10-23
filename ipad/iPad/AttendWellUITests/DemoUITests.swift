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
        let setup = app.staticTexts["Set up check-in"]
        XCTAssertTrue(setup.waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Scan pairing code"].exists)
        shot("\(label)-1-setup")

        app.buttons["Try a demo"].tap()
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
        XCTAssertTrue(app.staticTexts["Set up check-in"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Demo — names are made up and nothing is sent anywhere."].exists)

        // Nothing carried over: relaunching still opens on set-up, not on a saved session.
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Set up check-in"].waitForExistence(timeout: 20))
    }

    func testDemoPortrait() { runDemo(.portrait, "portrait") }
    func testDemoLandscape() { runDemo(.landscapeLeft, "landscape") }
}
