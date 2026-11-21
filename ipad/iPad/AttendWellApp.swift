import SwiftUI
import Foundation
import NearbyLink
import WorkshopCheckInCore

@main
@MainActor
struct AttendWellApp: App {
    private struct InternetPresentation: Identifiable {
        let id = UUID()
        let model: KioskModel?
        let scannedCode: String?
    }

    @StateObject private var nearbyKiosk = NearbyKioskModel(link: SpikeModel(allowSpike: false))
    private var nearby: SpikeModel { nearbyKiosk.link }
    @Environment(\.scenePhase) private var phase
    @State private var wasInBackground = false
    @State private var legacy: KioskModel?
    @State private var internet: InternetPresentation?
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
                    onDemo: { demo = try? DemoSession() },
                    participantContent: { AnyView(KioskParticipantView(model: nearbyKiosk)) })
            .onChange(of: phase) {
                if $0 == .background { wasInBackground = true }
                if $0 == .active && wasInBackground {
                    wasInBackground = false
                    nearby.appDidBecomeActive()
                }
            }
            .task(prepareSimulatorFixture)
            .fullScreenCover(item: $internet) { presentation in
                internetContent(presentation)
            }
            .fullScreenCover(item: $demo) { session in
                KioskView(model: session.model, onLeaveDemo: { session.end(); demo = nil })
            }
    }

    @MainActor private func prepareSimulatorFixture() async {
        #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
        guard internet == nil,
              let state = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--startup-internet-") }) else { return }
        if state != "--startup-internet-error" {
            let paired = state != "--startup-internet-setup"
            legacy = try? Self.fixture(home: paired, inMemory: true, directoryName: "StartupFixture",
                                       closed: state == "--startup-internet-closed").0
        }
        internet = InternetPresentation(model: legacy, scannedCode: nil)
        #endif
    }

    private func internetContent(_ presentation: InternetPresentation) -> some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text("AttendWell").font(.title.bold()).accessibilityAddTraits(.isHeader)
                Text(Self.version).font(.title3)
                KioskTile("Back to local check-in", icon: "arrow.left") { internet = nil }
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            if let model = presentation.model {
                KioskView(model: model, initialQR: presentation.scannedCode, onNearbyCode: { payload in
                    guard case .nearby(let code) = NearbyPairingQR(payload) else { return false }
                    nearby.pair(code)
                    internet = nil
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
        #if ATTENDWELL_STARTUP_FIXTURES && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--startup-nearby-open") {
            let setup = try? Self.fixture(home: false, inMemory: true, directoryName: "StartupFixture").0
            internet = InternetPresentation(model: setup, scannedCode: code)
            return
        }
        #endif
        let model = legacy ?? (try? Self.live())
        legacy = model
        internet = InternetPresentation(model: model, scannedCode: code)
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
            if !closed { _ = try store.recordCheckIn(eventId: offer.eventId, personToken: "pt_fixture_2") }
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

/// Maps the nearby roster and its existing disk queue onto the shared participant screens.
@MainActor
private final class NearbyKioskModel: KioskParticipantModel {
    let link: SpikeModel
    @Published private(set) var screen: KioskModel.Screen = .gettingNames
    @Published private(set) var workshopTitle: String?
    @Published private(set) var selected: PersonRow?
    @Published private var rows: [PersonRow] = []
    @Published var query = ""

    private var workshopId: String?
    private var pairingTag: String?
    var statusText: String { link.status }
    var message: String { screen == .gettingNames ? link.error ?? "" : "" }
    let busy = false

    init(link: SpikeModel) {
        self.link = link
        link.onRosterChanged = { [weak self] in self?.refresh() }
        refresh()
    }

    private var filteredRows: [PersonRow] {
        rows.filter { query.isEmpty || $0.displayName.localizedStandardContains(query) }
    }
    var findRows: [PersonRow] { filteredRows.filter { !$0.status.isDone } }
    var doneRows: [PersonRow] { filteredRows.filter { $0.status.isDone } }

    func select(_ row: PersonRow) {
        guard screen == .home, let current = rows.first(where: { $0.personToken == row.personToken }) else { return }
        selected = current
        screen = current.status.isDone ? .already : .confirm
    }

    func saveSelected() {
        guard screen == .confirm || screen == .commitFailed, let selected else { return }
        guard let snapshot = link.snapshot, snapshot.open else { goHome(); return }
        guard let name = snapshot.names.first(where: { $0.id == selected.personToken && !$0.hidden }) else { goHome(); return }
        if link.isCheckedIn(name) {
            self.selected = rows.first { $0.personToken == name.id }
            screen = .already
        } else if link.checkIn(name) {
            self.selected = PersonRow(personToken: name.id, displayName: name.displayName, status: .savedOnThisIPad)
            screen = .done
        } else {
            screen = .commitFailed
        }
    }

    func goHome() {
        selected = nil
        query = ""
        if let snapshot = link.snapshot, !snapshot.workshopId.isEmpty {
            screen = snapshot.open ? .home : .closed
        } else {
            screen = .gettingNames
        }
    }

    // NearbyIPadClient delivers from its persisted queue and retries on its own.
    func sendNow() async { if link.connectedMac == nil { link.reconnect() } }

    private func refresh() {
        let snapshot = link.snapshot
        workshopTitle = snapshot?.title
        rows = (snapshot?.names ?? []).filter { !$0.hidden }.map { name in
            PersonRow(personToken: name.id, displayName: name.displayName,
                      status: name.checkedIn == true ? .checkedIn : link.pendingNames.contains(name.id) ? .savedOnThisIPad : .notCheckedIn)
        }

        if workshopId != snapshot?.workshopId || pairingTag != link.pairingTag {
            workshopId = snapshot?.workshopId
            pairingTag = link.pairingTag
            goHome()
        } else if [.home, .gettingNames, .closed].contains(screen) {
            let next: KioskModel.Screen = if let snapshot, !snapshot.workshopId.isEmpty {
                snapshot.open ? .home : .closed
            } else { .gettingNames }
            if screen != next { goHome() }
        } else if (screen == .confirm || screen == .commitFailed) && snapshot?.open != true {
            goHome()
        } else if let selected, let row = rows.first(where: { $0.personToken == selected.personToken }), row.status.isDone {
            self.selected = row
        }
    }
}
