import SwiftUI
import Foundation
import WorkshopCheckInCore

/// AttendWell on the iPad. A normal launch pairs with the organiser's laptop
/// over HTTPS (`LiveHostTransport`) and keeps the session in local SQLite.
/// "Try a demo" on the set-up screen opens a practice workshop with made-up
/// names (`DemoSession`), entirely in memory.
/// In Debug builds only, the `--fixture-*` launch arguments open isolated,
/// fictional modes for screenshots, journeys and the platform probe; a Release
/// build does not contain them.
@main
@MainActor
struct AttendWellApp: App {
    #if DEBUG
    private let probeRequested = ProcessInfo.processInfo.arguments.contains("--fixture-platform-probe")
    @State private var probeResult = "Running fictional platform checks…"
    private let fixtureTransport: FictionalKioskTransport?
    #endif
    private let model: KioskModel?
    @State private var demo: DemoSession?

    init() {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        let previewHome = arguments.contains("--fixture-home")
        let previewSetup = arguments.contains("--fixture-setup")
        let fixtureDemo = arguments.contains("--fixture-demo")
        do {
            if previewHome || previewSetup || fixtureDemo {
                let built = try Self.fixture(home: previewHome, inMemory: previewHome || previewSetup,
                    directoryName: previewHome ? "WorkshopFixturePreview" : previewSetup ? "WorkshopFixtureSetupPreview" : "WorkshopFixture")
                model = built.0; fixtureTransport = built.1
            } else {
                model = try Self.live(); fixtureTransport = nil
            }
        } catch { model = nil; fixtureTransport = nil }
        #else
        model = try? Self.live()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if probeRequested {
                Text(probeResult).font(.title).padding().task {
                    probeResult = await PlatformProbe.run() ? "Fictional platform checks passed" : "Fictional platform checks failed"
                }
            } else {
                mainContent
            }
            #else
            mainContent
            #endif
        }
    }

    @ViewBuilder private var mainContent: some View {
        if let demo {
            KioskView(model: demo.model, onLeaveDemo: { demo.end(); self.demo = nil }).id(ObjectIdentifier(demo))
        } else if let model {
            VStack(spacing: 0) {
                KioskView(model: model, onTryDemo: { demo = try? DemoSession() })
                #if DEBUG
                if let fixtureTransport { FixtureControls(model: model, transport: fixtureTransport) }
                #endif
            }
        } else {
            Text("Couldn't open the saved check-ins. Nothing has been removed. Please speak to the organiser.")
                .font(.title).padding()
        }
    }

    /// Application Support folder excluded from backup, plus the local-only
    /// installation marker that scopes Keychain items to this install.
    private static func directory(_ name: String) throws -> (URL, String) {
        var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true).appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        let marker = directory.appendingPathComponent("installation-id")
        if FileManager.default.fileExists(atPath: marker.path) {
            return (directory, try String(contentsOf: marker, encoding: .utf8))
        }
        let installationID = UUID().uuidString
        try Data(installationID.utf8).write(to: marker, options: .atomic)
        return (directory, installationID)
    }

    /// The real app: Keychain credential and PIN (device-only), the session
    /// cache in SQLite, and the laptop over HTTPS with system TLS.
    private static func live() throws -> KioskModel {
        let (directory, installationID) = try directory("AttendWell")
        let credentials = KeychainCredentialVault(installationID: installationID)
        let pin = OrganiserPIN(vault: KeychainPINVault(installationID: installationID))
        let store = try CheckInStore(fileURL: directory.appendingPathComponent("check-ins.sqlite"))
        let transport = LiveHostTransport(vault: credentials, store: store)
        let pairing = PairingCoordinator(vault: credentials, store: store, transport: transport)
        return KioskModel(store: store, credentials: credentials, pairing: pairing, pin: pin,
                          transport: transport, fictional: false)
    }

    #if DEBUG
    private static func fixture(home previewHome: Bool, inMemory: Bool,
                                directoryName: String) throws -> (KioskModel, FictionalKioskTransport) {
        let (directory, installationID) = try directory(directoryName)
        let credentials: any CredentialVault = inMemory ? FixtureCredentialVault()
            : KeychainCredentialVault(installationID: installationID, service: "net.dominiklukes.attendwell.ipad.credentials")
        let pinVault: any PINVault = inMemory ? FixturePINVault()
            : KeychainPINVault(installationID: installationID, service: "net.dominiklukes.attendwell.ipad.pin")
        let pin = OrganiserPIN(vault: pinVault)
        let store = try CheckInStore(fileURL: directory.appendingPathComponent("check-ins.sqlite"))
        let offer = PairingOffer(eventId: "evt_fixture_spring", eventCode: "7Q2M", eventName: "Spring Workshop",
                                 eventDate: "14 October 2026", deviceLabel: "iPad 2")
        let names = ["Alex Morgan", "Riya Shah", "Sam Taylor", "Jo Okafor", "Sofia Lindgren", "Charlotte Alexandra Montgomery-Williams"]
        let people = names.enumerated().map { index, name in
            RosterPerson(personToken: "pt_fixture_\(index)", displayName: name, revision: 1, checkedIn: index == 3)
        }
        let host = FixtureHost(eventId: offer.eventId, eventCode: offer.eventCode, people: people,
            window: WindowInfo(state: .open, revision: 1, openedAt: Date(), closesAt: Date() + 7200), now: { Date() })
        let transport = FictionalKioskTransport(host: host, mode: previewHome ? .offline : .connected)
        if previewHome {
            // Screenshot fixture only: isolated database and in-memory
            // credentials/PIN. Never bypasses the normal pairing flow.
            _ = try store.applyRoster(RosterSnapshot(eventId: offer.eventId, eventCode: offer.eventCode,
                serverTime: Date(), window: WindowInfo(state: .open, revision: 1, openedAt: Date(), closesAt: Date() + 7200), people: people))
            try store.setPairing(eventId: offer.eventId, participantAddress: "https://checkin.example.org/s/k3v9")
            _ = try store.recordCheckIn(eventId: offer.eventId, personToken: "pt_fixture_2")
            try credentials.write(CredentialState(active: ActiveCredential(credential: DeviceCredential.generate(),
                address: "https://checkin.example.org/s/k3v9", offer: offer, deviceId: "dev_fixture_preview")))
            let salt = try DeviceCredential.generate()
            try pinVault.writePIN(PINState(salt: salt, hash: DeviceCredential.hash(salt + ":123456")))
        }
        let pairing = PairingCoordinator(vault: credentials, store: store, transport: FixturePairingTransport(offer: offer))
        return (KioskModel(store: store, credentials: credentials, pairing: pairing, pin: pin, transport: transport), transport)
    }
    #endif
}

#if DEBUG
private struct FixtureControls: View {
    @ObservedObject var model: KioskModel
    let transport: FictionalKioskTransport
    var body: some View {
        if model.unlocked && model.screen == .organiser {
            HStack {
                Menu("Fictional connection") {
                    ForEach(FictionalKioskTransport.Mode.allCases, id: \.self) { mode in
                        Button(mode.rawValue) { Task { await transport.setMode(mode); await model.sendNow() } }
                    }
                }
                Button("Close fixture event") { Task { await transport.host.close(); await model.sendNow() } }
                Button("Reopen fixture event") { Task { await transport.host.reopen(closesAt: Date() + 7200); await model.sendNow() } }
            }.font(.caption).padding().background(Color.yellow.opacity(0.2))
        }
    }
}
#endif
