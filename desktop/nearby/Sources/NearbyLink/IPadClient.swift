import Foundation
import MultipeerConnectivity
import Network

/// The iPad side: browses, invites the Mac whose discovery tag matches the key, and owns reconnection
/// (re-invite on lost peer or notConnected, backoff 0.5 s doubling to 5 s, and again on return to the foreground).
/// Check-ins are queued on disk first and resent on every (re)connection until acknowledged. Main queue only.
public final class NearbyIPadClient: NSObject, MCSessionDelegate, MCNearbyServiceBrowserDelegate {
    public var onLog: ((String) -> Void)?
    public var onPeer: ((String, PeerState) -> Void)?
    public var onDiscoveryTimedOut: ((Bool) -> Void)?
    /// (snapshot, sealed bytes received)
    public var onSnapshot: ((Snapshot, Int) -> Void)?
    /// Called whenever the number of unacknowledged check-ins changes.
    public var onQueueChanged: ((Int) -> Void)?
    public private(set) var connectedMac: String?
    public var pendingCount: Int { queue.items.count }
    public func pendingNames(for workshopId: String?) -> Set<String> {
        Set(queue.items.filter { $0.workshopId == workshopId }.map(\.nameId))
    }

    private let key: SharedKey
    private let device: String
    private let me: MCPeerID
    private var session: MCSession
    private var browser: MCNearbyServiceBrowser
    private let queue: PendingQueue
    private var candidates = Set<MCPeerID>()
    private var lastSnapshotVersion = 0
    private var workshopPeer: MCPeerID?
    private var backoff = 0.5
    private var retry: DispatchWorkItem?
    private var running = false
    private var connectingSince: Date?
    private var invitedPeer: MCPeerID?
    private var browsingSince = Date()
    private var disconnectedSince: Date?
    private var discoveryTimer: DispatchWorkItem?
    private var discoveryTimedOut = false
    private var pathMonitor: NWPathMonitor?
    private var sentAt: [String: Date] = [:]
    private var resendTimer: Timer?

    public init(key: SharedKey, deviceName: String, queue: PendingQueue) {
        self.key = key
        device = deviceName
        self.queue = queue
        me = MCPeerID(displayName: deviceName)
        session = MCSession(peer: me, securityIdentity: nil, encryptionPreference: .required)
        browser = MCNearbyServiceBrowser(peer: me, serviceType: nearbyServiceType)
        super.init()
        session.delegate = self
        browser.delegate = self
    }

    public func start() {
        guard !running else { return }
        running = true
        session.delegate = self
        browser.delegate = self
        browsingSince = Date()
        disconnectedSince = Date()
        browser.startBrowsingForPeers()
        scheduleRetry()
        watchForMissingMac()
        onLog?("browsing as \(device)")
        let monitor = NWPathMonitor()
        var receivedInitialPath = false
        monitor.pathUpdateHandler = { [weak self, weak monitor] _ in
            guard let self, let monitor, self.pathMonitor === monitor else { return }
            if receivedInitialPath { self.reconnect(reason: "network path changed") }
            receivedInitialPath = true
        }
        pathMonitor = monitor
        monitor.start(queue: .main)
        // While connected, anything still unacknowledged is sent again every 3 s: an ack lost on the way (or a connection MC
        // reports as up on one side only) must not leave a check-in waiting for the next reconnection. The Mac dedups by opId.
        resendTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, let p = self.session.connectedPeers.first else { return }
            let stale = self.queue.items.filter { Date().timeIntervalSince(self.sentAt[$0.opId] ?? .distantPast) >= 3 }
            guard !stale.isEmpty else { return }
            self.onLog?("resending \(stale.count) unacknowledged")
            for c in stale { self.send(.checkin(c), to: p) }
        }
    }
    public func stop() {
        running = false
        retry?.cancel()
        resendTimer?.invalidate()
        discoveryTimer?.cancel()
        discoveryTimer = nil
        pathMonitor?.cancel()
        pathMonitor = nil
        browser.delegate = nil
        browser.stopBrowsingForPeers()
        session.delegate = nil
        session.disconnect()
        candidates.removeAll()
        clearConnection()
    }

    /// Call when the app returns to the foreground.
    public func appDidBecomeActive() { reconnect(reason: "app returned to foreground") }

    public func reconnect(reason: String = "Reconnect tapped") {
        guard running else { return }
        onLog?("rebuilding the MC session and browser: \(reason)")
        replaceSession()
        restartBrowsing()
        resetRetry()
    }

    @discardableResult
    public func checkIn(nameId: String, at: String = CheckIn.isoNow(), opId: String = UUID().uuidString, workshopId: String? = nil) throws -> CheckIn {
        let c = CheckIn(opId: opId, nameId: nameId, at: at, workshopId: workshopId)
        try queue.append(c)
        onQueueChanged?(queue.items.count)
        if let p = session.connectedPeers.first { send(.checkin(c), to: p) }
        return c
    }

    private func send(_ m: Message, to peer: MCPeerID) {
        if case .checkin(let c) = m {
            // The old test helper acknowledged synthetic operations without
            // saving them. Hold real operations until this peer sends a real snapshot.
            guard c.workshopId == nil || workshopPeer == peer else { return }
            sentAt[c.opId] = Date()
        }
        do { try session.send(try m.sealed(with: key), toPeers: [peer], with: .reliable) } catch { onLog?("send failed: \(error)") }
    }

    // MARK: reconnection

    private func replaceSession() {
        session.delegate = nil
        session.disconnect()
        session = MCSession(peer: me, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        clearConnection()
    }

    private func clearConnection() {
        let priorMac = connectedMac
        connectingSince = nil
        invitedPeer = nil
        connectedMac = nil
        workshopPeer = nil
        disconnectedSince = disconnectedSince ?? Date()
        if let priorMac { onPeer?(priorMac, .notConnected) }
    }

    private func restartBrowsing() {
        browsingSince = Date()
        browser.delegate = nil
        browser.stopBrowsingForPeers()
        candidates.removeAll()
        browser = MCNearbyServiceBrowser(peer: me, serviceType: nearbyServiceType)
        browser.delegate = self
        browser.startBrowsingForPeers()
        watchForMissingMac()
    }

    private func watchForMissingMac() {
        guard connectedMac == nil, candidates.isEmpty else { return }
        // Keep the deadline across browser replacements so periodic recovery
        // cannot postpone the 15-second guidance.
        guard discoveryTimer == nil, !discoveryTimedOut else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.discoveryTimer = nil
            self.discoveryTimedOut = true
            self.onDiscoveryTimedOut?(true)
        }
        discoveryTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
    }

    private func foundMac() {
        discoveryTimer?.cancel()
        discoveryTimer = nil
        if discoveryTimedOut {
            discoveryTimedOut = false
            onDiscoveryTimedOut?(false)
        }
    }

    private func inviteIfNeeded() {
        guard running, session.connectedPeers.isEmpty, connectingSince == nil, let target = candidates.first else { return }
        onLog?("inviting \(target.displayName)")
        connectingSince = Date()
        invitedPeer = target
        browser.invitePeer(target, to: session, withContext: key.makeInvitation(inviterDisplayName: me.displayName), timeout: 8)
    }

    private func resetRetry() {
        backoff = 0.5
        scheduleRetry()
    }

    /// One retry chain. Give discovery and an in-flight invitation time to finish before rebuilding.
    private func scheduleRetry() {
        retry?.cancel()
        guard running, connectedMac == nil else { return }
        let delay = backoff
        let w = DispatchWorkItem { [weak self] in
            guard let self, self.running, self.connectedMac == nil else { return }
            let now = Date()
            if let since = self.connectingSince {
                if now.timeIntervalSince(since) >= 10 {
                    self.disconnectedSince = now
                    self.reconnect(reason: "invitation timed out")
                    return
                }
            } else if now.timeIntervalSince(self.disconnectedSince ?? self.browsingSince) >= 15 {
                self.disconnectedSince = now
                self.reconnect(reason: "still disconnected after 15 seconds")
                return
            } else if self.candidates.isEmpty {
                if now.timeIntervalSince(self.browsingSince) >= 10 { self.restartBrowsing() }
            } else {
                self.inviteIfNeeded()
            }
            self.backoff = min(self.backoff * 2, 5)
            self.scheduleRetry()
        }
        retry = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    // MARK: browser

    public func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        DispatchQueue.main.async { [self] in
            guard running, browser === self.browser else { return }
            guard info?["tag"] == key.tag else { onLog?("ignored \(peerID.displayName): wrong tag"); return }
            // A Mac that was killed and restarted comes back as a new peer with the same name while MC still reports the old
            // connection as up (it takes about 10 s to notice). The old one is dead: drop it so the new one is invited at once.
            if session.connectedPeers.contains(where: { $0.displayName == peerID.displayName && $0 != peerID }) {
                onLog?("\(peerID.displayName) came back as a new peer; dropping the stale connection")
                candidates.removeAll()
                replaceSession()
                resetRetry()
            }
            candidates.insert(peerID)
            foundMac()
            onLog?("found \(peerID.displayName)")
            inviteIfNeeded()
        }
    }

    public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        DispatchQueue.main.async { [self] in
            guard running, browser === self.browser else { return }
            candidates.remove(peerID)
            onLog?("lost \(peerID.displayName)")
            if connectedMac == nil { watchForMissingMac() }
        }
    }

    public func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        DispatchQueue.main.async {
            guard self.running, browser === self.browser else { return }
            self.onLog?("browsing failed: \(error)")
        }
    }

    // MARK: session

    public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async { [self] in
            guard running, session === self.session else { return }
            switch state {
            case .connected:
                connectingSince = nil
                invitedPeer = nil
                connectedMac = peerID.displayName
                disconnectedSince = nil
                foundMac()
                backoff = 0.5
                retry?.cancel()
                send(.hello(Hello(role: "ipad", device: device, lastSnapshotVersion: lastSnapshotVersion, unacked: queue.items.count)), to: peerID)
                for c in queue.items { send(.checkin(c), to: peerID) }
            case .notConnected:
                if invitedPeer == peerID { connectingSince = nil; invitedPeer = nil }
                if workshopPeer == peerID { workshopPeer = nil }
                if session.connectedPeers.isEmpty {
                    connectedMac = nil
                    disconnectedSince = disconnectedSince ?? Date()
                    watchForMissingMac()
                    scheduleRetry()
                }
            case .connecting: break
            @unknown default: break
            }
            onPeer?(peerID.displayName, state.peerState)
        }
    }

    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        DispatchQueue.main.async { [self] in
            guard running, session === self.session, session.connectedPeers.contains(peerID) else { return }
            guard let m = try? Message.open(data, with: key) else { onLog?("dropped unreadable message"); return }
            switch m {
            case .snapshot(let s):
                let firstRealSnapshot = s.acceptsWorkshopCheckIns == true && workshopPeer != peerID
                if s.acceptsWorkshopCheckIns == true { workshopPeer = peerID }
                lastSnapshotVersion = s.version
                onSnapshot?(s, data.count)
                if firstRealSnapshot {
                    for c in queue.items where c.workshopId != nil { send(.checkin(c), to: peerID) }
                }
            case .ack(let ids):
                let acknowledged = Set(ids)
                let accepted = queue.items.filter { acknowledged.contains($0.opId) && ($0.workshopId == nil || workshopPeer == peerID) }.map(\.opId)
                do {
                    try queue.remove(opIds: accepted)
                    accepted.forEach { sentAt[$0] = nil }
                    onQueueChanged?(queue.items.count)
                    onLog?("ack \(accepted.count), \(queue.items.count) left")
                } catch { onLog?("could not save the acknowledged queue; will retry") }
            case .hello, .checkin: break
            }
        }
    }

    public func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}
