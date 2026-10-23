import Foundation
import SwiftUI
import WorkshopCheckInCore

public protocol KioskTransport: DeviceTransport {
    func fetchRoster() async throws -> RosterSnapshot
}
/// The real laptop host: names list by cursor, check-ins over HTTPS.
extension LiveHostTransport: KioskTransport {}
extension FixtureHost: KioskTransport {
    public func fetchRoster() async throws -> RosterSnapshot { roster() }
}

/// Explicitly fictional fault controls for previews and the unsigned demo.
public actor FictionalKioskTransport: KioskTransport {
    public enum Mode: String, CaseIterable, Sendable { case connected, offline, revoked, updateNeeded, eventMoved }
    public let host: FixtureHost
    private var mode: Mode
    public init(host: FixtureHost, mode: Mode = .connected) { self.host = host; self.mode = mode }
    public func setMode(_ mode: Mode) { self.mode = mode }
    private func check() throws {
        switch mode {
        case .connected: return
        case .offline: throw TransportFailure.unreachable
        case .revoked: throw TransportFailure.revoked
        case .updateNeeded: throw TransportFailure.updateNeeded
        case .eventMoved: throw TransportFailure.eventMoved
        }
    }
    public func fetchRoster() async throws -> RosterSnapshot { try check(); return await host.roster() }
    public func submitOperations(eventId: String, body: Data) async throws -> Data {
        try check(); return try await host.submitOperations(eventId: eventId, body: body)
    }
}

@MainActor
public final class KioskModel: ObservableObject {
    public enum Screen: Equatable {
        case setup, scan, manual, cameraDenied, invalidQR, confirmEvent, pairing, pairingUnavailable, pairingExpired
        case setPIN, gettingNames, home, confirm, done, already, commitFailed, closed, paused
        case pin, organiser, handover, handoverSendFailed, recoverySaved, handoverConfirm, differentEvent
    }
    @Published public private(set) var screen: Screen = .setup
    @Published public private(set) var rows: [PersonRow] = []
    @Published public var query = ""
    @Published public var letter = ""
    @Published public private(set) var selected: PersonRow?
    @Published public private(set) var offer: PairingOffer?
    @Published public private(set) var active: ActiveCredential?
    @Published public private(set) var statusText = "Connected"
    @Published public private(set) var message = ""
    @Published public private(set) var busy = false
    @Published public private(set) var sending = false
    @Published public private(set) var pendingCount = 0
    @Published public private(set) var heldCount = 0
    @Published public private(set) var oldestPendingDate: Date?
    @Published public private(set) var namesUpdatedAt: Date?
    @Published public private(set) var pairingFailure: TransportFailure?
    @Published public private(set) var recoverySavedAt: Date?
    @Published public private(set) var recoveryFromHandover = false
    @Published public private(set) var recovery: RecoveryExport?
    @Published public private(set) var removal: RemovalPreview?
    @Published public private(set) var unlocked = false
    public var address = "https://checkin.example.org/s/k3v9"
    public var code = "K7QM-4TZP"
    public let fictional: Bool
    /// The reviewer/practice demo: no organiser or pairing screens are reachable.
    public let isDemo: Bool
    private let store: CheckInStore
    private let credentials: any CredentialVault
    private let pairing: PairingCoordinator
    private let pin: OrganiserPIN
    private let transport: any KioskTransport
    private var paused = false
    private var changingPIN = false
    private var setupReturn: Screen = .setup
    private var accessRevision = 0
    /// The PIN was asked for to replace a stranded pairing attempt.
    private var unlockForNewCode = false

    public init(store: CheckInStore, credentials: any CredentialVault, pairing: PairingCoordinator,
                pin: OrganiserPIN, transport: any KioskTransport, fictional: Bool = true, demo: Bool = false) {
        self.store = store; self.credentials = credentials; self.pairing = pairing
        self.pin = pin; self.transport = transport; self.fictional = fictional; self.isDemo = demo
        // Fictional example values belong to the demonstration only.
        if !fictional { address = ""; code = "" }
    }

    public var filteredRows: [PersonRow] {
        rows.filter { row in
            (query.isEmpty || row.displayName.localizedStandardContains(query)) &&
            (letter.isEmpty || row.displayName.uppercased().hasPrefix(letter))
        }
    }
    public var findRows: [PersonRow] { filteredRows.filter { !$0.status.isDone } }
    public var doneRows: [PersonRow] { filteredRows.filter { $0.status.isDone } }

    public func start() async {
        do {
            let state = try credentials.read()
            active = state.active; offer = state.active?.offer
            if let pending = state.pending {
                offer = pending.offer; address = pending.address; code = pending.code
                screen = .pairingUnavailable; message = "Still pairing…"; return
            }
            guard active != nil else { screen = .setup; return }
            if try store.pairing() == nil {
                try credentials.write(CredentialState()); try await pin.clear()
                active = nil; offer = nil; screen = .setup; return
            }
            if try await !pin.isSet() { screen = .setPIN; return }
            try refreshLocal(); goHome(); await sendNow()
        } catch { message = "Couldn't open the saved check-ins. Please speak to the organiser."; screen = .paused }
    }
    public func showManual() { if !busy { screen = .manual; message = "" } }
    public func showScanner() { if !busy { screen = .scan; message = "" } }
    public func cameraDenied() { screen = .cameraDenied }
    public func scan(_ text: String) async {
        do {
            let (base, scannedCode) = try ParticipantAddress.pairingQR(text)
            address = base.url.absoluteString; code = scannedCode; await inspectPairing()
        } catch { screen = .invalidQR }
    }
    /// Only an organiser who unlocked with the PIN may replace the current
    /// pairing outright; otherwise the laptop must prove itself (see
    /// `PairingCoordinator.inspect`).
    private var authority: PairingAuthority { unlocked ? .organiserPIN : .unverified }
    public func inspectPairing() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do { offer = try await pairing.inspect(address: address, code: code, authority: authority); screen = .confirmEvent; message = "" }
        catch CheckInError.differentEventHasUnsent { screen = .differentEvent }
        catch PairingError.invalidOrExpiredCode { screen = .pairingExpired }
        catch PairingError.organiserAuthorityRequired { askForPINToReplace() }
        catch PairingError.pendingAttemptExists { screen = .pairingUnavailable; message = "Retry the saved pairing attempt first." }
        catch TransportFailure.rateLimited { screen = .manual; message = Self.waitMessage + " Then try again." }
        catch { screen = .manual; message = "Can't reach the laptop at this address. Check the iPad is online, then try again." }
    }
    static let waitMessage = "The laptop asked this iPad to wait a minute."
    /// A new code that the paired laptop did not vouch for: only the PIN can
    /// replace the pairing. Nothing has changed on the iPad.
    private func askForPINToReplace() {
        accessRevision += 1; unlocked = false; unlockForNewCode = false; offer = active?.offer; screen = .pin
        message = "This code couldn't be confirmed by the laptop this iPad is paired with. Enter the organiser PIN, then choose Pair again."
    }
    public func confirmPairing() async {
        guard !busy, screen == .confirmEvent, let offer else { return }
        guard !sending else { message = "Sending is still in progress. Try again when it finishes."; return }
        do {
            try await pairing.begin(address: address, code: code, confirmed: offer, useOldDeviceProof: !paused,
                                    authority: authority)
            await retryPairing()
        } catch CheckInError.differentEventHasUnsent { screen = .differentEvent }
        catch PairingError.organiserAuthorityRequired { askForPINToReplace() }
        catch { message = "Pairing couldn't be saved. Your check-ins are still on this iPad." }
    }
    public func retryPairing() async {
        guard !busy else { return }
        busy = true; screen = .pairing; defer { busy = false }
        do {
            active = try await pairing.retry(); offer = active?.offer
            paused = false; unlocked = false; changingPIN = false; unlockForNewCode = false; setupReturn = .setup
            screen = .setPIN; message = ""
        } catch PairingError.invalidOrExpiredCode { screen = .pairingExpired }
        catch PairingError.organiserAuthorityRequired { askForPINToReplace() }
        catch CheckInError.differentEventHasUnsent { screen = .differentEvent }
        catch TransportFailure.rateLimited { screen = .pairingUnavailable; message = Self.waitMessage + " The same pairing attempt is saved for retry." }
        catch { screen = .pairingUnavailable; message = "Can't reach the laptop. The same pairing attempt is saved for retry." }
    }
    /// A saved pairing attempt that can't be finished (for example, the
    /// laptop restarted with a new address): the organiser replaces it with
    /// a new code. Needs the PIN while this iPad has a pairing; the current
    /// pairing, the saved check-ins and their ids are kept until the new
    /// pairing succeeds.
    public func useNewPairingCode() {
        guard screen == .pairingUnavailable, !busy else { return }
        setupReturn = .pairingUnavailable
        if active == nil { unlocked = false; screen = .setup; message = ""; return }
        showPIN(); unlockForNewCode = true
        message = "Enter the organiser PIN to use a new pairing code."
    }
    /// Setup can be left when there is a pairing or a saved attempt to go back to.
    public var canCancelSetup: Bool { active != nil || setupReturn == .pairingUnavailable }
    public func setPIN(_ value: String, confirmation: String) async {
        guard screen == .setPIN, !busy else { return }
        let revision = accessRevision
        do {
            try await pin.set(value, confirmation: confirmation)
            guard accessRevision == revision, screen == .setPIN else { return }
            if changingPIN { changingPIN = false; screen = .organiser; message = "PIN changed."; return }
            screen = .gettingNames; await sendNow()
            if screen == .gettingNames { goHome() }
        } catch { message = "Enter the same six digits twice." }
    }
    public func goHome() {
        unlocked = false; selected = nil; message = ""; query = ""; letter = ""
        if active == nil { screen = .setup; return }
        if paused { screen = .paused; return }
        do {
            try refreshLocal()
            if rows.isEmpty { screen = .gettingNames }
            else { screen = try store.isWindowOpen(eventId: active!.offer.eventId) ? .home : .closed }
        } catch { screen = .paused; message = "Couldn't read the names list. Please speak to the organiser." }
    }
    public func select(_ row: PersonRow) {
        guard screen == .home, !busy else { return }
        selected = row; screen = row.status.isDone ? .already : .confirm
    }
    public func saveSelected() {
        guard (screen == .confirm || screen == .commitFailed), let selected, let active, !paused else { return }
        do {
            let outcome = try store.recordCheckIn(eventId: active.offer.eventId, personToken: selected.personToken)
            // Disk commit is complete before any saved UI or network call.
            let status: RowStatus
            switch outcome { case .saved: status = .savedOnThisIPad; case .alreadyDone(let existing, _): status = existing }
            let committed = PersonRow(personToken: selected.personToken, displayName: selected.displayName, status: status)
            self.selected = committed
            rows = rows.map { $0.personToken == committed.personToken ? committed : $0 }
            screen = .done
            // A subsequent list read cannot turn a committed operation into
            // "Nothing has been marked" or lose the name on its saved screen.
            do {
                try refreshLocal()
                self.selected = rows.first { $0.personToken == committed.personToken } ?? committed
            } catch { statusText = "Needs organiser"; message = "Saved on this iPad. The names list couldn't be refreshed." }
        } catch CheckInError.windowClosed { screen = .closed }
        catch { screen = .commitFailed }
    }
    public func showPIN() { guard !isDemo else { return }; accessRevision += 1; unlocked = false; unlockForNewCode = false; screen = .pin; message = "" }
    public func unlock(_ value: String) async {
        guard screen == .pin else { return }
        let revision = accessRevision
        do {
            try await pin.unlock(value)
            guard accessRevision == revision, screen == .pin else { return }
            unlocked = true
            if unlockForNewCode { unlockForNewCode = false; screen = .setup; message = ""; return }
            screen = .organiser; try refreshLocal(); message = ""
        }
        catch PINError.locked { message = "Too many tries. Try again in 30 seconds." }
        catch { message = "That PIN isn't right. Try again." }
    }
    public func changePIN() { guard unlocked else { return }; changingPIN = true; screen = .setPIN; message = "" }
    public func backToOrganiser() { guard unlocked else { return }; screen = .organiser; message = "" }
    public func rePair() {
        guard unlocked else { return }
        guard !sending else { message = "Sending is still in progress. Try again when it finishes."; return }
        setupReturn = .organiser; screen = .setup
    }
    /// A fresh QR from the laptop this iPad is paired with is the only
    /// forgotten-PIN override; the laptop proves it (Kiosk journey J6).
    public func forgottenPIN() { unlocked = false; unlockForNewCode = false; setupReturn = .pin; screen = .setup }
    public func cancelSetup() {
        offer = active?.offer
        if setupReturn == .pairingUnavailable {
            unlocked = false
            if let pending = try? credentials.read().pending { offer = pending.offer }
        }
        screen = setupReturn
    }
    public func suspend() { accessRevision += 1; unlocked = false; if screen == .organiser || screen == .setPIN && changingPIN || screen == .handover || screen == .handoverSendFailed || screen == .handoverConfirm || screen == .recoverySaved { screen = .pin } }

    public func sendNow() async {
        guard let active, !busy, !sending else { return }
        sending = true; defer { sending = false }
        statusText = "Sending"
        do {
            let snapshot = try await transport.fetchRoster()
            guard self.active == active else { return }
            guard snapshot.eventId == active.offer.eventId else { throw TransportFailure.eventMoved }
            _ = try store.applyRoster(snapshot)
            namesUpdatedAt = snapshot.serverTime
            let report = await store.deliverPending(eventId: active.offer.eventId, via: transport)
            switch report.stop {
            case .transport(let failure): throw failure
            case .invalidResponse, .storageFailure: throw PairingError.invalidResponse
            default: break
            }
            statusText = "Connected"; message = ""; pairingFailure = nil
            try refreshLocal()
            if screen == .gettingNames || screen == .closed { goHome() }
            else if screen == .home, try !store.isWindowOpen(eventId: active.offer.eventId) { screen = .closed }
            if let selected { self.selected = rows.first { $0.personToken == selected.personToken } }
        } catch {
            if let failure = error as? TransportFailure {
                pairingFailure = failure
                if failure == .revoked || failure == .eventMoved { paused = true; statusText = "Needs organiser"; if !unlocked { screen = .paused } }
                else if failure == .updateNeeded { statusText = "Needs organiser"; message = "Update this app to send check-ins. They are saved safely in the meantime." }
                else if failure == .rateLimited { statusText = "Saved on this iPad"; message = Self.waitMessage + " The check-ins are still saved on this iPad." }
                else { statusText = "Saved on this iPad"; message = "Couldn't reach the laptop. The check-ins are still saved on this iPad." }
            } else { statusText = "Needs organiser"; message = "Couldn't read the laptop's reply. Saved check-ins stay on this iPad." }
            try? refreshLocal()
            // A window the laptop reported closed counts even when the rest failed.
            if screen == .home, let id = self.active?.offer.eventId, (try? store.isWindowOpen(eventId: id)) == false {
                screen = .closed
            }
        }
    }
    public func beginHandover() {
        guard unlocked, let active else { return }
        guard !sending else { message = "Sending is still in progress. Try again when it finishes."; return }
        do {
            try refreshLocal()
            let preview = try store.removalPreview(eventId: active.offer.eventId); removal = preview
            screen = preview.unsentOpIds.isEmpty || preview.unsentCoveredBySavedRecovery ? .handoverConfirm : .handover
        }
        catch { message = "Couldn't check the saved check-ins. Nothing has been removed." }
    }
    public func sendForHandover() async {
        guard unlocked, screen == .handover || screen == .handoverSendFailed else { return }
        await sendNow()
        guard unlocked else { return }
        beginHandover()
        if screen == .handover && statusText != "Connected" { screen = .handoverSendFailed }
    }
    public func prepareRecovery(fromHandover: Bool = false) {
        guard unlocked, let active else { return }
        recovery = nil; recoverySavedAt = nil
        do { recovery = try store.exportRecovery(eventId: active.offer.eventId, deviceId: active.deviceId)
            recoveryFromHandover = fromHandover; message = ""
        } catch { message = "Couldn't create a recovery file. Nothing has been removed." }
    }
    /// Called ONLY by a successful fileExporter completion, never by presenting
    /// a share sheet or generating bytes.
    public func recoverySaved() {
        guard unlocked, let recovery else { return }
        do { try store.confirmRecoverySaved(recovery.exportId); recoverySavedAt = Date(); screen = .recoverySaved }
        catch { message = "Couldn't record that the file was saved. Nothing has been removed." }
    }
    public func continueAfterRecovery() {
        guard unlocked else { return }
        if recoveryFromHandover { beginHandover() }
        else { screen = .organiser }
    }
    public func handOver() async {
        guard unlocked, screen == .handoverConfirm, let removal else { return }
        guard !sending else { message = "Sending is still in progress. Try again when it finishes."; return }
        busy = true; defer { busy = false }
        do {
            try store.removeEventData(confirming: removal)
            // If credential cleanup fails, next launch must not restore a
            // removed names list; startup cross-checks store pairing below.
            active = nil; offer = nil; rows = []; unlocked = false; recovery = nil; self.removal = nil; screen = .setup
            do { try credentials.write(CredentialState()); try await pin.clear() }
            catch { screen = .paused; message = "The names list has been removed. Pairing cleanup couldn't finish. Please speak to the organiser." }
        } catch { message = "Nothing further has been removed. Saved check-ins require a current recovery file." }
    }
    private func refreshLocal() throws {
        guard let active else { return }
        rows = try store.rows(eventId: active.offer.eventId)
        let summary = try store.outboxSummary(eventId: active.offer.eventId)
        pendingCount = summary.pending; heldCount = summary.held
        oldestPendingDate = try store.oldestPendingDate(eventId: active.offer.eventId)
    }
}

extension RowStatus {
    public var label: String {
        switch self {
        case .checkedIn: return "Checked in"
        case .savedOnThisIPad: return "Saved on this iPad"
        case .withTheOrganiser: return "With the organiser"
        case .notCheckedIn: return "Not checked in"
        }
    }
}
