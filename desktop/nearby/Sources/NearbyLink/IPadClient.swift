import Foundation
import MultipeerConnectivity

/// The iPad side: browses, invites the Mac whose discovery tag matches the key, and owns reconnection
/// (re-invite on lost peer or notConnected, backoff 0.5 s doubling to 5 s, and again on return to the foreground).
/// Check-ins are queued on disk first and resent on every (re)connection until acknowledged. Main queue only.
public final class NearbyIPadClient: NSObject, MCSessionDelegate, MCNearbyServiceBrowserDelegate {
    public var onLog: ((String) -> Void)?
    public var onPeer: ((String, PeerState) -> Void)?
    /// (snapshot, sealed bytes received)
    public var onSnapshot: ((Snapshot, Int) -> Void)?
    /// Called whenever the number of unacknowledged check-ins changes.
    public var onQueueChanged: ((Int) -> Void)?
    public private(set) var connectedMac: String?
    public var pendingCount: Int { queue.items.count }

    private let key: SharedKey
    private let device: String
    private let me: MCPeerID
    private var session: MCSession
    private let browser: MCNearbyServiceBrowser
    private let queue: PendingQueue
    private var candidates = Set<MCPeerID>()
    private var lastSnapshotVersion = 0
    private var backoff = 0.5
    private var retry: DispatchWorkItem?
    private var running = false
    private var connectingSince: Date?
    private var browsingSince = Date()
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
        running = true; browsingSince = Date(); browser.startBrowsingForPeers(); scheduleRetry(); onLog?("browsing as \(device)")
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
    public func stop() { running = false; retry?.cancel(); resendTimer?.invalidate(); browser.stopBrowsingForPeers(); session.disconnect() }

    /// Call when the app returns to the foreground.
    public func appDidBecomeActive() { guard running else { return }; backoff = 0.5; if connectedMac == nil { restartBrowsing(); inviteIfNeeded() } }

    @discardableResult
    public func checkIn(nameId: String, at: String = CheckIn.isoNow(), opId: String = UUID().uuidString) -> CheckIn {
        let c = CheckIn(opId: opId, nameId: nameId, at: at)
        queue.append(c)
        onQueueChanged?(queue.items.count)
        if let p = session.connectedPeers.first { send(.checkin(c), to: p) }
        return c
    }

    private func send(_ m: Message, to peer: MCPeerID) {
        if case .checkin(let c) = m { sentAt[c.opId] = Date() }
        do { try session.send(try m.sealed(with: key), toPeers: [peer], with: .reliable) } catch { onLog?("send failed: \(error)") }
    }

    // MARK: reconnection

    /// An invitation that neither connects nor fails within 10 s is stuck inside MC (seen on one run in five between two processes on
    /// one Mac). Throw the session away, make a fresh one and browse again; the next attempt starts clean.
    private func resetSession() {
        onLog?("invitation stuck; rebuilding the MC session")
        session.delegate = nil
        session.disconnect()
        session = MCSession(peer: me, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        connectingSince = nil
        connectedMac = nil
        restartBrowsing()
    }

    private func restartBrowsing() { browsingSince = Date(); browser.stopBrowsingForPeers(); candidates.removeAll(); browser.startBrowsingForPeers() }

    private func inviteIfNeeded() {
        guard running, session.connectedPeers.isEmpty, let target = candidates.first else { return }
        // An invitation in flight is left alone (a second one restarts the handshake and it never finishes); MC's own timeout
        // (below) ends it with notConnected, which brings the next attempt.
        if let since = connectingSince {
            if Date().timeIntervalSince(since) < 10 { return }
            resetSession()
            return   // the browser was restarted: the next attempt follows the rediscovery
        }
        onLog?("inviting \(target.displayName)")
        connectingSince = Date()
        browser.invitePeer(target, to: session, withContext: key.makeInvitation(inviterDisplayName: me.displayName), timeout: 8)
    }

    /// One pending timer: when it fires and we are still not connected, re-invite (restarting the browser if nothing was found).
    private func scheduleRetry() {
        retry?.cancel()
        guard running, connectedMac == nil else { return }
        let delay = backoff
        let w = DispatchWorkItem { [weak self] in
            guard let self, self.running, self.connectedMac == nil else { return }
            // Discovery can take a few seconds; restarting the browser at every attempt would keep resetting it.
            if self.candidates.isEmpty { if Date().timeIntervalSince(self.browsingSince) > 10 { self.restartBrowsing() } } else { self.inviteIfNeeded() }
            self.backoff = min(self.backoff * 2, 5)
            self.scheduleRetry()
        }
        retry = w
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
    }

    // MARK: browser

    public func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        DispatchQueue.main.async { [self] in
            guard info?["tag"] == key.tag else { onLog?("ignored \(peerID.displayName): wrong tag"); return }
            // A Mac that was killed and restarted comes back as a new peer with the same name while MC still reports the old
            // connection as up (it takes about 10 s to notice). The old one is dead: drop it so the new one is invited at once.
            if session.connectedPeers.contains(where: { $0.displayName == peerID.displayName && $0 != peerID }) {
                onLog?("\(peerID.displayName) came back as a new peer; dropping the stale connection")
                session.disconnect()
                connectedMac = nil
                connectingSince = nil
                scheduleRetry()
            }
            candidates.insert(peerID)
            onLog?("found \(peerID.displayName)")
            inviteIfNeeded()
        }
    }

    public func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        DispatchQueue.main.async { [self] in
            candidates.remove(peerID)
            onLog?("lost \(peerID.displayName)")
            if connectedMac == nil { scheduleRetry() }
        }
    }

    public func browser(_ browser: MCNearbyServiceBrowser, didNotStartBrowsingForPeers error: Error) {
        DispatchQueue.main.async { self.onLog?("browsing failed: \(error)") }
    }

    // MARK: session

    public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async { [self] in
            onPeer?(peerID.displayName, state.peerState)
            switch state {
            case .connected:
                connectingSince = nil
                connectedMac = peerID.displayName
                backoff = 0.5
                retry?.cancel()
                send(.hello(Hello(role: "ipad", device: device, lastSnapshotVersion: lastSnapshotVersion, unacked: queue.items.count)), to: peerID)
                for c in queue.items { send(.checkin(c), to: peerID) }
            case .notConnected:
                connectingSince = nil
                if session.connectedPeers.isEmpty { connectedMac = nil; scheduleRetry() }
            case .connecting: break
            @unknown default: break
            }
        }
    }

    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        DispatchQueue.main.async { [self] in
            guard let m = try? Message.open(data, with: key) else { onLog?("dropped unreadable message"); return }
            switch m {
            case .snapshot(let s): lastSnapshotVersion = s.version; onSnapshot?(s, data.count)
            case .ack(let ids): queue.remove(opIds: ids); ids.forEach { sentAt[$0] = nil }; onQueueChanged?(queue.items.count); onLog?("ack \(ids.count), \(queue.items.count) left")
            case .hello, .checkin: break
            }
        }
    }

    public func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}
