import SwiftUI
import Foundation
import NearbyLink
import WorkshopCheckInCore

@main
@MainActor
struct AttendWellApp: App {
    @StateObject private var nearby = SpikeModel(allowSpike: false)
    @Environment(\.scenePhase) private var phase
    @State private var legacy: KioskModel?
    @State private var showingInternet = false
    @State private var scannedInternetCode: String?
    @State private var demo: DemoSession?

    #if DEBUG
    private let probeRequested = ProcessInfo.processInfo.arguments.contains("--fixture-platform-probe")
    @State private var probeResult = "Running fictional platform checks…"
    private let fixture: (KioskModel, FictionalKioskTransport)?

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let home = arguments.contains("--fixture-home")
        let setup = arguments.contains("--fixture-setup")
        let demo = arguments.contains("--fixture-demo")
        if home || setup || demo {
            fixture = try? Self.fixture(home: home, inMemory: home || setup,
                directoryName: home ? "WorkshopFixturePreview" : setup ? "WorkshopFixtureSetupPreview" : "WorkshopFixture")
        } else {
            fixture = nil
        }
    }
    #endif

    var body: some Scene {
        WindowGroup { mainContent.preferredColorScheme(.light) }
    }

    @ViewBuilder private var mainContent: some View {
        #if DEBUG
        if probeRequested {
            Text(probeResult).font(.title).padding().task {
                probeResult = await PlatformProbe.run() ? "Fictional platform checks passed" : "Fictional platform checks failed"
            }
        } else if let fixture {
            if let demo {
                KioskView(model: demo.model, onLeaveDemo: { demo.end(); self.demo = nil }).id(ObjectIdentifier(demo))
            } else {
                VStack(spacing: 0) {
                    KioskView(model: fixture.0, onTryDemo: { demo = try? DemoSession() })
                    FixtureControls(model: fixture.0, transport: fixture.1)
                }
            }
        } else {
            nearbyContent
        }
        #else
        nearbyContent
        #endif
    }

    private var nearbyContent: some View {
        ContentView(model: nearby, version: Self.version, onInternet: openInternet,
                    onDemo: { demo = try? DemoSession() })
            .onChange(of: phase) { if $0 == .active { nearby.appDidBecomeActive() } }
            .task(prepareSimulatorFixture)
            .fullScreenCover(isPresented: $showingInternet) { internetContent }
            .fullScreenCover(item: $demo) { session in
                KioskView(model: session.model, onLeaveDemo: { session.end(); demo = nil })
            }
    }

    @MainActor private func prepareSimulatorFixture() async {
        #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
        guard !showingInternet,
              let state = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--startup-internet-") }) else { return }
        if state != "--startup-internet-error" {
            let paired = state != "--startup-internet-setup"
            legacy = try? Self.fixture(home: paired, inMemory: true, directoryName: "StartupFixture",
                                       closed: state == "--startup-internet-closed").0
        }
        showingInternet = true
        #endif
    }

    private var internetContent: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("AttendWell").font(.title.bold()).accessibilityAddTraits(.isHeader)
                Text(Self.version).font(.title3)
                KioskTile("Back to local check-in", icon: "arrow.left") { showingInternet = false }
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            if let legacy {
                KioskView(model: legacy, initialQR: scannedInternetCode, onNearbyCode: { payload in
                    guard case .nearby(let code) = NearbyPairingQR(payload) else { return false }
                    nearby.pair(code)
                    showingInternet = false
                    return true
                })
            } else {
                Text("Couldn’t open internet check-in. Please speak to the organiser.").font(.title2.bold()).padding(24)
                Spacer()
            }
        }
        .foregroundStyle(KioskTile.ink)
        .background(KioskTile.surface.ignoresSafeArea())
    }

    private func openInternet(_ code: String?) {
        if legacy == nil { legacy = try? Self.live() }
        scannedInternetCode = code
        showingInternet = true
    }

    private static var version: String {
        let bundle = Bundle.main
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "AttendWell \(version) (\(build))"
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

    #if DEBUG || (ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator))
    private static func fixture(home previewHome: Bool, inMemory: Bool,
                                directoryName: String, closed: Bool = false) throws -> (KioskModel, FictionalKioskTransport) {
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
        let window = WindowInfo(state: closed ? .closed : .open, revision: 1, openedAt: Date(),
                                closesAt: closed ? Date() - 1 : Date() + 7200)
        let host = FixtureHost(eventId: offer.eventId, eventCode: offer.eventCode, people: people, window: window, now: { Date() })
        let transport = FictionalKioskTransport(host: host, mode: previewHome ? .offline : .connected)
        if previewHome {
            // Screenshot fixture only: isolated database and in-memory
            // credentials/PIN. Never bypasses the normal pairing flow.
            _ = try store.applyRoster(RosterSnapshot(eventId: offer.eventId, eventCode: offer.eventCode,
                serverTime: Date(), window: window, people: people))
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

