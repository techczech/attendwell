import SwiftUI
import UniformTypeIdentifiers
import WorkshopCheckInCore
#if os(iOS)
import UIKit
#endif

private enum KioskStyle {
    static let teal = Color(red: 11/255, green: 107/255, blue: 107/255)
    static let warm = Color(red: 251/255, green: 248/255, blue: 243/255)
    static let amber = Color(red: 251/255, green: 227/255, blue: 176/255)
}

private struct RecoveryDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

public struct KioskView: View {
    @ObservedObject private var model: KioskModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var heroSize = 56.0
    @ScaledMetric(relativeTo: .title2) private var nameSize = 28.0
    @State private var address = "https://checkin.example.org/s/k3v9"
    @State private var code = "K7QM-4TZP"
    @State private var pin = ""
    @State private var confirmation = ""
    @State private var editingConfirmation = false
    @State private var exportFile = false
    @State private var recoveryURL: URL?
    @AccessibilityFocusState private var headingFocused: Bool
    private let onTryDemo: (() -> Void)?
    private let onLeaveDemo: (() -> Void)?
    /// `onTryDemo` adds the secondary "Try a demo" button to the set-up screen;
    /// `onLeaveDemo` is called by the banner of a demo model.
    public init(model: KioskModel, onTryDemo: (() -> Void)? = nil, onLeaveDemo: (() -> Void)? = nil) {
        self.model = model
        self.onTryDemo = onTryDemo; self.onLeaveDemo = onLeaveDemo
        _address = State(initialValue: model.address); _code = State(initialValue: model.code)
    }

    public var body: some View {
        VStack(spacing: 0) {
            if model.isDemo {
                HStack(spacing: 16) {
                    Text("Demo — names are made up and nothing is sent anywhere.").font(.callout.weight(.semibold))
                    Spacer(minLength: 0)
                    Button("Leave demo") { onLeaveDemo?() }.buttonStyle(.borderedProminent).controlSize(.regular)
                }
                .padding(.horizontal, 16).padding(.vertical, 8).frame(maxWidth: .infinity)
                .background(KioskStyle.amber)
            } else if model.fictional {
                Text("Fictional fixture demonstration · no laptop connection")
                    .font(.caption.weight(.semibold)).padding(8).frame(maxWidth: .infinity)
                    .background(KioskStyle.amber)
            }
            content
        }
        .background(KioskStyle.warm).tint(KioskStyle.teal)
        .buttonStyle(.bordered).controlSize(.large)
        .task { await model.start() }
        .task(id: model.screen) {
            pin = ""; confirmation = ""; editingConfirmation = false; headingFocused = true
            if model.screen == .done {
                // Saved has already rendered; acknowledgement changes the copy
                // only after a definite fixture response.
                await model.sendNow()
                try? await Task.sleep(for: .seconds(3))
                if !Task.isCancelled && model.screen == .done { model.goHome() }
            }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                if !Task.isCancelled, scenePhase == .active,
                   [.home, .closed, .gettingNames].contains(model.screen) { await model.sendNow() }
            }
        }
        .onChange(of: scenePhase) { phase in if phase == .background { model.suspend() } }
        .fileExporter(isPresented: $exportFile,
            document: RecoveryDocument(data: model.recovery?.data ?? Data()), contentType: .json,
            defaultFilename: model.recovery?.fileName ?? "check-ins.attendance-recovery.json") { result in
                if case .success(let url) = result { recoveryURL = url; model.recoverySaved() }
            }
    }

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .home: home
        case .setup:
            panel("Set up check-in", icon: "qrcode", detail: "Scan the pairing code shown on the organiser's laptop.") {
                action("Scan pairing code", icon: "qrcode.viewfinder") { model.showScanner() }
                action("Enter a code instead", icon: "keyboard") { model.showManual() }
                if model.canCancelSetup { action("Cancel", icon: "xmark") { model.cancelSetup() } }
                if let onTryDemo {
                    Button("Try a demo", action: onTryDemo).buttonStyle(.plain).font(.body)
                        .foregroundStyle(.secondary).underline().padding(.top, 12).disabled(model.busy)
                        .accessibilityHint("Opens a practice check-in with made-up names. Nothing is sent or saved.")
                }
            }
        case .scan:
            scanner
        case .cameraDenied:
            panel("Camera is off", icon: "camera.fill", detail: "Check-in needs the camera to scan the code. You can allow it in Settings, or enter the code instead.") {
                #if os(iOS)
                action("Open Settings", icon: "gear") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                #endif
                action("Enter a code instead", icon: "keyboard") { model.showManual() }
            }
        case .invalidQR:
            panel("This isn't a pairing code.", icon: "exclamationmark.triangle", detail: "Ask the organiser to open Pair an iPad on the laptop.") {
                action("Scan pairing code", icon: "qrcode.viewfinder") { model.showScanner() }
                action("Enter a code instead", icon: "keyboard") { model.showManual() }
            }
        case .manual:
            panel("Enter a code", icon: "keyboard", detail: "Both are shown on the laptop under “Can't scan?”") {
                TextField("Address", text: $address).textFieldStyle(.roundedBorder).font(.title2).accessibilityLabel("Address")
                TextField("Code", text: $code).textFieldStyle(.roundedBorder).font(.title2.monospaced()).accessibilityLabel("Code")
                action("Pair", icon: "link") { model.address = address; model.code = code; Task { await model.inspectPairing() } }
                action("Cancel", icon: "xmark") { model.cancelSetup() }
            }
        case .confirmEvent:
            panel("Pair this iPad with:", icon: "link", detail: model.offer.map { "\($0.eventName) · \($0.eventDate) · Event code \($0.eventCode)" } ?? "") {
                Text("Event code. Check it matches the laptop.").font(.title2)
                Text("This iPad will be called \(model.offer?.deviceLabel ?? "")").font(.title2.bold())
                Text("Named on the laptop.")
                action("Pair", icon: "checkmark") { Task { await model.confirmPairing() } }
                action("Cancel", icon: "xmark") { model.cancelSetup() }
            }
        case .pairing:
            panel("Still pairing…", icon: "link", detail: "Keep this screen open.") { ProgressView() }
        case .pairingUnavailable:
            panel("Can't reach the laptop", icon: "wifi.slash", detail: "Can't reach the laptop at this address. Check the iPad is online, then try again.") {
                action("Try again", icon: "arrow.clockwise") { Task { await model.retryPairing() } }
                Text("Has the laptop restarted or shown a new code? Use the new pairing code instead.")
                action("Use a new pairing code", icon: "qrcode") { model.useNewPairingCode() }
            }
        case .pairingExpired:
            panel("That code can't be used", icon: "hourglass", detail: "This pairing code has expired or has already been used. Ask the organiser for a new one.") {
                action("Scan pairing code", icon: "qrcode.viewfinder") { model.showScanner() }
                action("Enter a code instead", icon: "keyboard") { model.showManual() }
            }
        case .setPIN:
            panel("Choose a 6-digit organiser PIN.", icon: "lock", detail: "Participants won't need it.") {
                SecureField("New PIN", text: $pin).font(.title).textFieldStyle(.roundedBorder)
                    .onTapGesture { editingConfirmation = false }
                    .onChange(of: pin) { value in pin = digits(value); if pin.count == 6 { editingConfirmation = true } }
                SecureField("Enter it again.", text: $confirmation).font(.title).textFieldStyle(.roundedBorder)
                    .onTapGesture { editingConfirmation = true }.onChange(of: confirmation) { confirmation = digits($0) }
                digitPad(Binding(get: { editingConfirmation ? confirmation : pin }, set: { value in
                    if editingConfirmation { confirmation = value } else { pin = value }
                }))
                Text("If you forget it, show a new pairing code on the laptop and scan it.")
                action("Continue", icon: "arrow.right") { Task { await model.setPIN(pin, confirmation: confirmation) } }
            }
        case .gettingNames:
            panel("Getting the names list…", icon: "list.bullet", detail: "Still waiting for the laptop. Keep this iPad connected to the internet.") {
                ProgressView(); action("Try again", icon: "arrow.clockwise") { Task { await model.sendNow() } }
                if !model.isDemo { action("Organiser", icon: "lock") { model.showPIN() } }
            }
        case .confirm:
            panel("Is this you?", icon: "person", detail: model.selected?.displayName ?? "") {
                action("Yes, check me in", icon: "checkmark") { model.saveSelected() }
                action("No, go back", icon: "arrow.left") { model.goHome() }
            }
        case .done:
            done
        case .already:
            panel(alreadyTitle, icon: statusIcon(model.selected?.status ?? .notCheckedIn), detail: alreadyDetail) {
                action("OK", icon: "checkmark") { model.goHome() }
            }
        case .commitFailed:
            panel("Sorry, that didn't save.", icon: "exclamationmark.triangle", detail: "Nothing has been marked. Please try again, or speak to the organiser.") {
                action("Try again", icon: "arrow.clockwise") { model.saveSelected() }
                action("Back to the list", icon: "arrow.left") { model.goHome() }
            }
        case .closed:
            panel("Check-in is closed", icon: "door.left.hand.closed", detail: "Please speak to the organiser.") {
                if !model.isDemo { action("Organiser", icon: "lock") { model.showPIN() } }
            }
        case .paused:
            panel("This iPad is paused", icon: "pause.circle", detail: "Please speak to the organiser.") {
                if !model.isDemo { action("Organiser", icon: "lock") { model.showPIN() } }
            }
        case .pin:
            panel("Organiser PIN", icon: "lock", detail: "Forgotten the PIN? Show a new pairing code on the laptop and scan it.") {
                SecureField("Six-digit PIN", text: $pin).font(.title).textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await model.unlock(pin); pin = "" } }
                    .onChange(of: pin) { pin = digits($0) }
                digitPad($pin)
                action("Continue", icon: "lock.open") { Task { await model.unlock(pin); pin = "" } }
                action("Scan a new pairing code", icon: "qrcode.viewfinder") { model.forgottenPIN(); model.showScanner() }
                action("Check-in", icon: "arrow.left") { model.goHome() }
            }
        case .organiser: organiser
        case .handover:
            panel("\(model.pendingCount) check-ins haven't reached the laptop yet.", icon: "hand.raised", detail: "Send them to the laptop first.") {
                action("Send now", icon: "paperplane") { Task { await model.sendForHandover() } }
                action("Laptop not available? Save a recovery file", icon: "square.and.arrow.up") { saveRecovery(handover: true) }
                action("Cancel", icon: "xmark") { model.backToOrganiser() }
            }
        case .handoverSendFailed:
            panel("Couldn't reach the laptop.", icon: "wifi.slash", detail: "The \(model.pendingCount) check-ins are still saved on this iPad. Try again, or save a recovery file and import it on the laptop.") {
                action("Try again", icon: "arrow.clockwise") { Task { await model.sendForHandover() } }
                action("Save recovery file", icon: "doc") { saveRecovery(handover: true) }
                action("Cancel", icon: "xmark") { model.backToOrganiser() }
            }
        case .recoverySaved:
            panel("Recovery file saved", icon: "doc", detail: "Send this file to the organiser's laptop and import it under Devices → Import iPad recovery file.") {
                Text("Names and check-ins only. No email addresses.")
                if let recoveryURL {
                    ShareLink(item: recoveryURL) { Label("Share file", systemImage: "square.and.arrow.up").font(.title2.bold()).frame(minHeight: 64) }
                }
                action(model.recoveryFromHandover ? "Continue to hand over" : "Back to Organiser", icon: "arrow.right") { model.continueAfterRecovery() }
            }
        case .handoverConfirm:
            panel("Hand over this iPad?", icon: "hand.raised", detail: handoverDetail) {
                Button("Hand over", role: .destructive) { Task { await model.handOver() } }.font(.title2.bold()).frame(minHeight: 72)
                action("Cancel", icon: "xmark") { model.backToOrganiser() }
            }
        case .differentEvent:
            panel("This is a different event", icon: "exclamationmark.triangle", detail: "Send the saved check-ins or save a recovery file before pairing with another event.") {
                if !model.isDemo { action("Organiser", icon: "lock") { model.showPIN() } }
            }
        }
    }

    private var home: some View {
        VStack(spacing: 0) {
            HStack(spacing: 24) {
                Image(systemName: "person.2").font(.system(size: 52)).accessibilityHidden(true)
                VStack(alignment: .leading) {
                    Text("Please check in").font(.system(size: heroSize, weight: .bold)).accessibilityAddTraits(.isHeader).accessibilityFocused($headingFocused)
                    Text("Find your name, then tap it.").font(.title2)
                }
                Spacer()
            }.padding(28).foregroundStyle(.white).background(KioskStyle.teal)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    TextField("Search your name", text: $model.query).font(.title2).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Search your name")
                    ScrollView(.horizontal) {
                        HStack {
                            Button("All") { model.letter = "" }
                            ForEach(Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), id: \.self) { c in
                                Button(String(c)) { model.letter = String(c) }.frame(minWidth: 48, minHeight: 48)
                                    .accessibilityLabel("Names beginning with \(String(c))")
                            }
                        }
                    }
                    section("Find your name", icon: "person", rows: model.findRows)
                    if model.findRows.isEmpty {
                        Text(model.doneRows.isEmpty ? "No names match '\(model.query)'. Check the spelling, or speak to the organiser." : "No names here match '\(model.query)'. Look under Already done below.")
                            .font(.title3)
                    }
                    Divider()
                    section("Already done", icon: "clock.arrow.circlepath", rows: model.doneRows)
                }.padding(24)
            }
            ViewThatFits(in: .horizontal) { footer(horizontal: true); footer(horizontal: false) }
                .frame(maxWidth: .infinity, alignment: .leading).background(Color.white)
        }
    }
    private func section(_ title: String, icon: String, rows: [PersonRow]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(title, systemImage: icon).font(.title.bold()).accessibilityAddTraits(.isHeader)
            LazyVGrid(columns: typeSize.isAccessibilitySize ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 300), spacing: 16)], spacing: 16) {
                ForEach(rows, id: \.personToken) { row in
                    Button { model.select(row) } label: {
                        HStack(spacing: 16) {
                            Image(systemName: row.status.isDone ? statusIcon(row.status) : "person").font(.title)
                            VStack(alignment: .leading, spacing: 8) {
                                Text(row.displayName).font(.system(size: nameSize, weight: .bold)).fixedSize(horizontal: false, vertical: true)
                                if row.status.isDone { Text(row.status.label).font(.body) }
                            }
                            Spacer(minLength: 0)
                            if !row.status.isDone { Image(systemName: "chevron.right") }
                        }.padding(20).frame(maxWidth: .infinity, minHeight: 108, alignment: .leading)
                    }.buttonStyle(.plain).foregroundStyle(row.status.isDone ? Color.primary : KioskStyle.teal)
                        .background(row.status == .savedOnThisIPad || row.status == .withTheOrganiser ? KioskStyle.amber : Color.white)
                        .clipShape(RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.gray.opacity(0.4)))
                        .accessibilityLabel("\(row.displayName), \(row.status.label)")
                        .accessibilityHint(row.status.isDone ? "Shows your saved status" : "Opens check-in confirmation")
                }
            }
        }
    }
    private func footer(horizontal: Bool) -> some View {
        let layout = horizontal ? AnyLayout(HStackLayout(spacing: 24)) : AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
        return layout {
            VStack(alignment: .leading) { Text(model.offer?.eventName ?? "").bold(); Text(model.offer?.eventDate ?? "") }
            Text("Can't find your name? Please speak to the organiser.")
            Text(model.statusText).font(.body.bold())
            if !model.isDemo { Button { model.showPIN() } label: { Label("Organiser", systemImage: "lock") }.frame(minHeight: 48) }
        }.padding(20).background(Color.white)
    }
    private var done: some View {
        let name = model.selected?.displayName ?? ""
        let status = model.selected?.status ?? .savedOnThisIPad
        let title = status == .checkedIn ? "You're checked in, \(name)." : status == .withTheOrganiser ? "Thank you, \(name)." : "Saved on this iPad, \(name)."
        let detail = status == .checkedIn ? "" : status == .withTheOrganiser ? "The organiser will confirm your check-in." : "You don't need to wait. It will be sent to the organiser's laptop."
        return Button { model.goHome() } label: {
            VStack(spacing: 32) {
                Spacer(); Image(systemName: statusIcon(status)).font(.system(size: 96)).accessibilityHidden(true)
                Text(title).font(.system(size: heroSize, weight: .bold)).multilineTextAlignment(.center).accessibilityFocused($headingFocused)
                Text(detail).font(.title2).multilineTextAlignment(.center)
                Spacer(); Label("Tap anywhere to continue", systemImage: "hand.tap").font(.title2)
            }.padding(36).frame(maxWidth: .infinity, maxHeight: .infinity)
        }.buttonStyle(.plain).background(status == .checkedIn ? KioskStyle.teal : KioskStyle.amber)
            .foregroundStyle(status == .checkedIn ? Color.white : Color.primary)
            .accessibilityLabel(title + " " + detail + " Tap to continue")
    }
    private var organiser: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Organiser").font(.largeTitle.bold()).accessibilityFocused($headingFocused)
                Text("\(model.offer?.eventName ?? "") · Event code \(model.offer?.eventCode ?? "") · This iPad: \(model.active?.offer.deviceLabel ?? "")").font(.title2)
                Text("Not yet sent \(model.pendingCount)").font(.title.bold())
                if let oldest = model.oldestPendingDate { Text("Oldest \(oldest.formatted(date: .omitted, time: .shortened))") }
                Text("Needs review on the laptop \(model.heldCount)").font(.title2)
                if let updated = model.namesUpdatedAt { Text("Names list updated \(updated.formatted(date: .omitted, time: .shortened))") }
                Text(model.statusText).font(.title2)
                if model.pairingFailure == .revoked || model.pairingFailure == .eventMoved {
                    Text("This iPad was disconnected on the laptop. \(model.pendingCount) check-ins are saved here. Ask the organiser to choose Pair again for \(model.active?.offer.deviceLabel ?? "this iPad") on the laptop, then scan the new code.").font(.title2)
                }
                Text(model.message).font(.title3)
                action("Send now", icon: "paperplane") { Task { await model.sendNow() } }
                action("Save recovery file", icon: "doc") { saveRecovery(handover: false) }
                action("Pair again", icon: "qrcode") { model.rePair() }
                action("Hand over this iPad", icon: "hand.raised") { model.beginHandover() }
                action("Change PIN", icon: "lock") { model.changePIN() }
                Text("About · \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Development build") · Protocol 1")
                Text("Check-ins send while this app is open. Sending while the iPad is locked or the app is closed isn't guaranteed.")
                Text("Deleting this app removes check-ins saved on this iPad. Save a recovery file first.")
                action("Check-in", icon: "arrow.left") { model.goHome() }
            }.padding(32)
        }
    }
    private var alreadyTitle: String {
        let name = model.selected?.displayName ?? ""
        switch model.selected?.status {
        case .checkedIn: return "\(name) is already checked in."
        case .savedOnThisIPad: return "\(name) is saved on this iPad and will be sent to the organiser."
        default: return "Please speak to the organiser about \(name)."
        }
    }
    private var alreadyDetail: String { model.selected?.status == .checkedIn ? "If that isn't right, please speak to the organiser." : "" }
    private var handoverDetail: String {
        let n = model.removal?.unsentOpIds.count ?? 0
        return n == 0 ? "This removes the names list and the pairing from this iPad. Nothing is waiting to be sent." :
            "This removes the names list, the pairing and \(n) unsent check-ins from this iPad: \(model.removal?.unsentNames.joined(separator: ", ") ?? ""). They are in the recovery file saved\(model.recoverySavedAt.map { " at " + $0.formatted(date: .omitted, time: .shortened) } ?? ""). Check it has reached the laptop first."
    }
    private func saveRecovery(handover: Bool) { model.prepareRecovery(fromHandover: handover); if model.recovery != nil { exportFile = true } }
    private func statusIcon(_ status: RowStatus) -> String {
        switch status { case .checkedIn: return "checkmark.circle"; case .savedOnThisIPad: return "square.and.arrow.down"
        case .withTheOrganiser: return "hand.raised"; case .notCheckedIn: return "person" }
    }
    private func action(_ title: String, icon: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) { Label(title, systemImage: icon).font(.title2.bold()).frame(minHeight: 64) }.disabled(model.busy)
    }
    private func digits(_ value: String) -> String { String(value.filter { $0.isASCII && $0.isNumber }.prefix(6)) }
    private func digitPad(_ value: Binding<String>) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
            ForEach(["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "delete"], id: \.self) { key in
                if key.isEmpty { Color.clear.frame(height: 72).accessibilityHidden(true) }
                else {
                    Button {
                        if key == "delete" { if !value.wrappedValue.isEmpty { value.wrappedValue.removeLast() } }
                        else if value.wrappedValue.count < 6 { value.wrappedValue += key }
                    } label: {
                        if key == "delete" { Image(systemName: "delete.left").font(.title).frame(maxWidth: .infinity, minHeight: 72) }
                        else { Text(key).font(.largeTitle.bold()).frame(maxWidth: .infinity, minHeight: 72) }
                    }.accessibilityLabel(key == "delete" ? "Delete last digit" : key)
                }
            }
        }.frame(maxWidth: 420)
    }
    private func panel<Actions: View>(_ title: String, icon: String, detail: String, @ViewBuilder actions: () -> Actions) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                Image(systemName: icon).font(.system(size: 72)).foregroundStyle(KioskStyle.teal).accessibilityHidden(true)
                Text(title).font(.system(size: heroSize, weight: .bold)).accessibilityAddTraits(.isHeader).accessibilityFocused($headingFocused)
                Text(detail).font(.title2)
                if !model.message.isEmpty { Text(model.message).font(.title3).foregroundStyle(.red) }
                actions()
            }.frame(maxWidth: 850, alignment: .leading).padding(36).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    @ViewBuilder private var scanner: some View {
        #if os(iOS)
        VStack(spacing: 24) {
            Text("Point the camera at the code on the laptop.").font(.largeTitle.bold()).padding()
            PairingScanner(onCode: { value in Task { await model.scan(value) } }, onDenied: { model.cameraDenied() })
            HStack { action("Enter a code instead", icon: "keyboard") { model.showManual() }; action("Cancel", icon: "xmark") { model.cancelSetup() } }.padding()
        }
        #else
        panel("Scan pairing code", icon: "camera", detail: "Camera scanning requires an iPad.") { action("Enter a code instead", icon: "keyboard") { model.showManual() } }
        #endif
    }
}
