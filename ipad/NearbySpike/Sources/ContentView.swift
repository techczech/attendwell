import AVFoundation
import SwiftUI
import NearbyLink

struct ContentView: View {
    @ObservedObject var model: SpikeModel
    var version = ""
    var onInternet: ((String?) -> Void)?
    var onDemo: (() -> Void)?
    var participantContent: (() -> AnyView)?
    @State private var connectionsOpen = false
    @State private var afterConnections: (() -> Void)?
    @State private var search = ""
    @State private var scanning = false
    @State private var cameraMessage: String?
    @State private var enteringCode = false
    @State private var typedCode = ""
    @State private var pairing: ShortCodeClient?
    @State private var pairingMessage: String?
    @State private var scannedPayload: String?

    private var namesFirst: Bool {
        model.connectedMac != nil && model.snapshot?.open == true
    }

    private var shown: [NameEntry] {
        (model.snapshot?.names ?? []).filter {
            !$0.hidden && (search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        Group {
            if let participantContent {
                VStack(spacing: 0) {
                    HStack {
                        Spacer()
                        Button { connectionsOpen = true } label: {
                            Label("Connections", systemImage: "link").font(.body.bold())
                                .padding(.horizontal, 16).frame(minHeight: 44)
                        }.buttonStyle(KioskTile.FilledStyle(prominent: true))
                    }.padding(.horizontal, 24).padding(.vertical, 8)
                    if model.hasPairing {
                        participantContent()
                    } else {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("AttendWell").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                            Text("Open Connections to set up check-in.").font(.title2)
                            if let error = model.error { Text(error).font(.title2.bold()) }
                        }.padding(36).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    }
                }
            } else {
                spikeContent
            }
        }
        .foregroundStyle(KioskTile.ink)
        .background(KioskTile.surface.ignoresSafeArea())
        .preferredColorScheme(.light)
        .sheet(isPresented: $connectionsOpen, onDismiss: resumeFromConnections, content: connections)
        .onChange(of: model.snapshot?.workshopId) { _ in search = "" }
    }

    private var spikeContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                if model.hasPairing {
                    if let snapshot = model.snapshot { workshop(snapshot) }
                    if namesFirst { namesList }
                    KioskTile("Connect to a different Mac", icon: "qrcode.viewfinder", action: { openScanner() })
                } else {
                    KioskTile("Connect Mac locally", icon: "qrcode.viewfinder", prominent: true, action: { openScanner() })
                }
                if let onInternet {
                    KioskTile("Connect computer over internet", icon: "globe") { onInternet(nil) }
                }
                if let onDemo, !model.hasPairing { KioskTile("Try a demo", icon: "play.circle", action: onDemo) }
                if !namesFirst && model.snapshot?.open == true { namesList }
            }
            .frame(maxWidth: 880, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity, alignment: .top)
        }
        .sheet(isPresented: $scanning, onDismiss: handleCode, content: scanner)
    }

    private func leaveConnections(_ action: @escaping () -> Void) {
        if connectionsOpen {
            afterConnections = action
            connectionsOpen = false
        } else {
            action()
        }
    }

    private func resumeFromConnections() {
        let action = afterConnections
        afterConnections = nil
        action?()
    }

    private func connections() -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Connections").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text(model.status).font(.title2.bold()).accessibilityIdentifier("nearby-connection")
                Text("Unsent check-ins: \(model.pending)").font(.title3)
                Text(version).font(.title3)
                if let error = model.error { Text(error).font(.title3.bold()) }
                KioskTile("Connect Mac locally", icon: "qrcode.viewfinder", prominent: true) { openScanner() }
                if let onInternet {
                    KioskTile("Connect computer over internet", icon: "globe") {
                        leaveConnections { onInternet(nil) }
                    }
                }
                KioskTile("Enter local code", icon: "keyboard") { openScanner(enterCode: true) }
                if let onDemo {
                    KioskTile("Try a demo", icon: "play.circle") {
                        leaveConnections(onDemo)
                    }
                }
                KioskTile("Done", icon: "checkmark") { connectionsOpen = false }
            }.padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(KioskTile.ink)
        .background(KioskTile.surface.ignoresSafeArea())
        .sheet(isPresented: $scanning, onDismiss: handleCode, content: scanner)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("AttendWell").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            if !version.isEmpty { Text(version).font(.title3.weight(.medium)) }
            Text(model.status).font(.title.bold()).accessibilityIdentifier("nearby-connection")
            if model.hasPairing {
                Text("Unsent check-ins: \(model.pending)").font(.title3.weight(.semibold))
            }
            if let error = model.error { Text(error).font(.title2.bold()) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func workshop(_ snapshot: Snapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(snapshot.title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            if snapshot.open {
                Text("Find your name, then tap it to check in.").font(.title2)
            } else if !snapshot.workshopId.isEmpty {
                Text("Check-in is closed").font(.title2.bold())
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private var namesList: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let confirmation = model.confirmation {
                Label(confirmation, systemImage: "checkmark.circle.fill")
                    .font(.title2.bold()).foregroundStyle(.white)
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    .background(KioskTile.teal, in: RoundedRectangle(cornerRadius: 14))
                    .accessibilityIdentifier("nearby-confirmation")
            }
            TextField("Search your name", text: $search, prompt: Text("Search your name").foregroundColor(KioskTile.ink))
                .font(.title2).padding(16)
                .background(.white, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(KioskTile.teal, lineWidth: 1))
            if shown.isEmpty { Text("No names to show.").font(.title2) }
            LazyVStack(spacing: 12) {
                ForEach(shown, id: \.id) { name in
                    if model.isCheckedIn(name) {
                        Label("\(name.displayName) · Checked in", systemImage: "checkmark.circle.fill")
                            .font(.title2.bold()).padding(16)
                            .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
                            .background(KioskTile.tile, in: RoundedRectangle(cornerRadius: 14))
                    } else {
                        KioskTile(name.displayName, icon: "person", prominent: true) { model.checkIn(name) }
                    }
                }
            }
        }
    }

    private func openScanner(enterCode: Bool = false) {
        cameraMessage = nil
        enteringCode = enterCode
        typedCode = ""
        pairingMessage = nil
        scanning = true
    }

    private func scanner() -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if enteringCode {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Enter the Mac code").font(.largeTitle.bold())
                        Text("On the Mac, open Connect iPad. Type the eight characters shown beside the QR code.").font(.title2)
                        TextField("8-character code", text: $typedCode)
                            .keyboardType(.asciiCapable).textInputAutocapitalization(.characters)
                            .autocorrectionDisabled().font(.title.monospaced()).textFieldStyle(.roundedBorder)
                            .disabled(pairing != nil)
                        if let pairingMessage { Text(pairingMessage).font(.title2.bold()) }
                        KioskTile("Connect", icon: "link", prominent: true, action: connectByCode)
                            .disabled(pairing != nil)
                    }
                }
            } else {
                Text("Scan the code on the Mac").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                Text("Open Connect iPad on the Mac and point the camera at the QR code.").font(.title2)
                if let cameraMessage {
                    Text(cameraMessage).font(.title2.bold())
                    Spacer()
                } else {
                    PairingScanner(onCode: { payload in
                        scannedPayload = payload
                        scanning = false
                    }, onDenied: {
                        switch AVCaptureDevice.authorizationStatus(for: .video) {
                        case .denied: cameraMessage = "Allow camera access in Settings, or enter the Mac code below."
                        case .restricted: cameraMessage = "Camera access is restricted. Enter the Mac code below."
                        default: cameraMessage = "The camera could not start. Enter the Mac code below."
                        }
                    })
                    .frame(maxHeight: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                KioskTile("Enter the Mac code", icon: "keyboard") { enteringCode = true }
            }
            KioskTile("Back", icon: "arrow.left") { scanning = false }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .foregroundStyle(KioskTile.ink)
        .background(KioskTile.surface)
        .onDisappear { pairing?.stop(); pairing = nil }
    }

    private func connectByCode() {
        guard let code = ShortCodeClient.normalise(typedCode) else {
            pairingMessage = "Enter the eight characters shown on the Mac."
            return
        }
        pairingMessage = "Looking for the Mac…"
        let client = ShortCodeClient(code: code) { key in
            pairing = nil
            guard let key else {
                pairingMessage = "Could not connect. Keep Connect iPad open on the Mac, check its current code and try again."
                return
            }
            model.pair(key)
            scanning = false
        }
        pairing = client
        client.start()
    }

    private func handleCode() {
        guard let payload = scannedPayload else { return }
        scannedPayload = nil
        switch NearbyPairingQR(payload) {
        case .nearby(let code): model.pair(code)
        case .internet(let code):
            if let onInternet { leaveConnections { onInternet(code) } } else { model.invalidCode() }
        case nil: model.invalidCode()
        }
    }
}

struct KioskTile: View {
    static let ink = Color(red: 0.06, green: 0.10, blue: 0.10)
    static let surface = Color(red: 0.96, green: 0.97, blue: 0.95)
    static let teal = Color(red: 0.00, green: 0.30, blue: 0.27)
    static let tile = Color(red: 0.87, green: 0.92, blue: 0.89)

    let title: String
    let icon: String
    var prominent = false
    let action: () -> Void

    init(_ title: String, icon: String, prominent: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.prominent = prominent
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.title2.bold()).multilineTextAlignment(.leading)
                .padding(.horizontal, 20).padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 80, alignment: .leading)
        }
        .buttonStyle(FilledStyle(prominent: prominent))
    }

    struct FilledStyle: ButtonStyle {
        var prominent: Bool

        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .foregroundStyle(prominent ? Color.white : KioskTile.ink)
                .background(prominent ? KioskTile.teal : KioskTile.tile, in: RoundedRectangle(cornerRadius: 14))
                .scaleEffect(configuration.isPressed ? 0.99 : 1)
        }
    }
}
