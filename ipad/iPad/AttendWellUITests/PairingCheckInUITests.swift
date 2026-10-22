import XCTest

/// Drives the real app through pairing and one check-in against a live laptop register.
/// Inputs come from the environment (xcodebuild test with TEST_RUNNER_-prefixed variables), never from the repo:
///   AW_PAIR_ADDRESS, AW_PAIR_CODE, AW_PIN (6 digits, to set), AW_PARTICIPANT (exact name on the list).
final class PairingCheckInUITests: XCTestCase {
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tap(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 20) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Could not find \(what)")
        element.tap()
    }

    private func replaceText(_ field: XCUIElement, with text: String) {
        field.tap()
        let existing = (field.value as? String) ?? ""
        if !existing.isEmpty {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        }
        field.typeText(text)
    }

    func testPairAndCheckIn() throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["AW_PAIR_ADDRESS"], let code = env["AW_PAIR_CODE"],
              let pin = env["AW_PIN"], let name = env["AW_PARTICIPANT"],
              !address.isEmpty, !code.isEmpty, !pin.isEmpty, !name.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_AW_PAIR_ADDRESS, TEST_RUNNER_AW_PAIR_CODE, TEST_RUNNER_AW_PIN and TEST_RUNNER_AW_PARTICIPANT to run this live test against a laptop register.")
        }
        XCTAssertEqual(pin.count, 6, "AW_PIN must be six digits")

        let app = XCUIApplication()
        app.launch()
        shot("01-setup")

        tap(app.buttons["Enter a code instead"], "Enter a code instead")
        let addressField = app.textFields["Address"]
        XCTAssertTrue(addressField.waitForExistence(timeout: 10))
        replaceText(addressField, with: address)
        replaceText(app.textFields["Code"], with: code)
        // Screenshot omitted here on purpose: the fields now show the live address and code.
        tap(app.buttons["Pair"], "Pair")

        // Confirm event screen.
        let confirmTitle = app.staticTexts["Pair this iPad with:"]
        XCTAssertTrue(confirmTitle.waitForExistence(timeout: 60), "No confirm-event screen; the laptop may be unreachable or the code used")
        shot("02-confirm-event")
        tap(app.buttons["Pair"], "Pair (confirm)")

        // Set the organiser PIN with the on-screen pad.
        XCTAssertTrue(app.staticTexts["Choose a 6-digit organiser PIN."].waitForExistence(timeout: 60), "No set-PIN screen")
        shot("03-set-pin")
        app.secureTextFields["New PIN"].tap()
        for _ in 0..<2 {
            for d in pin { tap(app.buttons[String(d)], "pad key \(d)", timeout: 5) }
        }
        shot("04-pin-entered")
        tap(app.buttons["Continue"], "Continue")

        // Home list.
        let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(name),")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 90), "Participant \(name) not on the home list")
        shot("05-home-list")
        XCTAssertTrue(row.label.hasSuffix("Not checked in"), "Unexpected starting status: \(row.label)")
        row.tap()

        tap(app.buttons["Yes, check me in"], "Yes, check me in")
        shot("06-saved")

        // Wait for the row to show checked in (the app sends on save, then every 10 seconds).
        let checkedIn = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@ AND label ENDSWITH %@", "\(name),", "Checked in")).firstMatch
        XCTAssertTrue(checkedIn.waitForExistence(timeout: 90), "Row never showed checked in")
        let connected = app.staticTexts["Connected"]
        XCTAssertTrue(connected.waitForExistence(timeout: 30), "Status never showed Connected")
        shot("07-checked-in-connected")

        // Unsent count lives on the organiser screen.
        tap(app.buttons["Organiser"], "Organiser")
        let pinField = app.secureTextFields["Six-digit PIN"]
        XCTAssertTrue(pinField.waitForExistence(timeout: 10))
        pinField.tap()
        for d in pin { tap(app.buttons[String(d)], "pad key \(d)", timeout: 5) }
        tap(app.buttons["Continue"], "Continue (unlock)")
        XCTAssertTrue(app.staticTexts["Not yet sent 0"].waitForExistence(timeout: 20), "Unsent count is not 0")
        shot("08-organiser-unsent-0")
    }
}
