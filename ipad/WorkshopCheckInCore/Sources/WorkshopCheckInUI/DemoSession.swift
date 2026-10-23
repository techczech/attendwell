import Foundation
import WorkshopCheckInCore

/// "Try a demo": a self-contained practice workshop with made-up names, for
/// reviewers and curious users. It uses the in-memory fictional laptop and
/// in-memory credentials and PIN, so it makes no network calls and touches no
/// Keychain item. The names list lives in a SQLite file in a private temporary
/// folder that `end()` deletes; nothing survives leaving the demo.
@MainActor
public final class DemoSession {
    public static let workshopName = "Demo workshop"
    public static let names = [
        "Ada Example", "Ben Sample", "Cleo Placeholder", "Dev Demo", "Elin Testperson",
        "Farah Fictional", "Gus Imaginary", "Hana Madeup", "Ivo Pretend", "Jules Notreal",
    ]
    public let model: KioskModel
    private let directory: URL

    public init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AttendWellDemo-\(UUID().uuidString)", isDirectory: true)
        let address = "https://demo.invalid/s/demo"
        let offer = PairingOffer(eventId: "evt_demo", eventCode: "DEMO", eventName: Self.workshopName,
                                 eventDate: "Practice session", deviceLabel: "Demo iPad")
        let people = Self.names.enumerated().map { index, name in
            RosterPerson(personToken: "pt_demo_\(index)", displayName: name, revision: 1, checkedIn: false)
        }
        let window = WindowInfo(state: .open, revision: 1, openedAt: Date(), closesAt: nil)
        let host = FixtureHost(eventId: offer.eventId, eventCode: offer.eventCode, people: people,
                               window: window, now: { Date() })
        do {
            let store = try CheckInStore(fileURL: directory.appendingPathComponent("demo.sqlite"))
            _ = try store.applyRoster(RosterSnapshot(eventId: offer.eventId, eventCode: offer.eventCode,
                                                     serverTime: Date(), window: window, people: people))
            try store.setPairing(eventId: offer.eventId, participantAddress: address)
            let credentials = FixtureCredentialVault(CredentialState(active: ActiveCredential(
                credential: "dc_demo", address: address, offer: offer, deviceId: "dev_demo")))
            // A PIN nobody knows: the demo has no organiser screens, but the
            // model needs one to be set to open the door screen.
            let pinVault = FixturePINVault()
            let salt = try DeviceCredential.generate()
            try pinVault.writePIN(PINState(salt: salt, hash: DeviceCredential.hash(salt + ":" + DeviceCredential.generate())))
            let pin = OrganiserPIN(vault: pinVault)
            let transport = FictionalKioskTransport(host: host, mode: .connected)
            let pairing = PairingCoordinator(vault: credentials, store: store,
                                             transport: FixturePairingTransport(offer: offer))
            model = KioskModel(store: store, credentials: credentials, pairing: pairing, pin: pin,
                               transport: transport, fictional: true, demo: true)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    /// Deletes everything the demo wrote. Call when leaving the demo.
    public func end() { try? FileManager.default.removeItem(at: directory) }
    public var storageExists: Bool { FileManager.default.fileExists(atPath: directory.path) }
}
