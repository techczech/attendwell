import Foundation
import MultipeerConnectivity

public let nearbyServiceType = "attendwell-nb"

public enum PeerState: String { case connected, connecting, notConnected }

extension MCSessionState {
    var peerState: PeerState { switch self { case .connected: return .connected; case .connecting: return .connecting; default: return .notConnected } }
}

/// The Mac side: advertises, accepts only invitations carrying a valid proof, answers `hello` with the current snapshot,
/// and hands every check-in to the parent (which records it first and then calls `ack`).
/// All state lives on the main queue; MC callbacks hop onto it.
public final class NearbyMacHost: NSObject, MCSessionDelegate, MCNearbyServiceAdvertiserDelegate {
    public var onCheckin: ((CheckIn, String) -> Void)?
    public var onPeer: ((String, PeerState) -> Void)?
    public var onLog: ((String) -> Void)?
    /// Called after a snapshot was handed to MC for one peer: (peer, sealed bytes).
    public var onSnapshotSent: ((String, Int) -> Void)?

    private let key: SharedKey
    private let me: MCPeerID
    private let session: MCSession
    private let advertiser: MCNearbyServiceAdvertiser
    private var snapshot: Snapshot?
    private var seenNonces = Set<Data>()
    private let device: String

    public init(key: SharedKey, deviceName: String) {
        self.key = key
        device = deviceName
        me = MCPeerID(displayName: deviceName)
        session = MCSession(peer: me, securityIdentity: nil, encryptionPreference: .required)
        advertiser = MCNearbyServiceAdvertiser(peer: me, discoveryInfo: ["tag": key.tag], serviceType: nearbyServiceType)
        super.init()
        session.delegate = self
        advertiser.delegate = self
    }

    public func start() { advertiser.startAdvertisingPeer(); onLog?("advertising as \(device) tag=\(key.tag)") }
    public func stop() { advertiser.stopAdvertisingPeer(); session.disconnect() }

    public func setSnapshot(_ s: Snapshot) {
        snapshot = s
        for p in session.connectedPeers { send(.snapshot(s), to: p) }
    }

    /// The parent has recorded these; tell every connected iPad (acks are idempotent).
    public func ack(opIds: [String]) {
        guard !opIds.isEmpty else { return }
        if session.connectedPeers.isEmpty { onLog?("ack for \(opIds.count) dropped: no peer connected (the iPad resends)"); return }
        for p in session.connectedPeers { send(.ack(opIds), to: p) }
    }

    private func send(_ m: Message, to peer: MCPeerID) {
        do {
            let data = try m.sealed(with: key)
            try session.send(data, toPeers: [peer], with: .reliable)
            if case .snapshot = m { onSnapshotSent?(peer.displayName, data.count) }
        } catch { onLog?("send failed to \(peer.displayName): \(error)") }
    }

    // MARK: advertiser

    public func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID, withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        DispatchQueue.main.async { [self] in
            guard let nonce = key.verifyInvitation(context, inviterDisplayName: peerID.displayName), !seenNonces.contains(nonce) else {
                onLog?("rejected invitation from \(peerID.displayName)")
                invitationHandler(false, nil)
                return
            }
            seenNonces.insert(nonce)
            onLog?("accepted invitation from \(peerID.displayName)")
            invitationHandler(true, session)
        }
    }

    public func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didNotStartAdvertisingPeer error: Error) {
        DispatchQueue.main.async { self.onLog?("advertising failed: \(error)") }
    }

    // MARK: session

    public func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        DispatchQueue.main.async { [self] in
            onPeer?(peerID.displayName, state.peerState)
            // A handshake that fell through leaves the advertisement stale: the iPad's browser then never sees the Mac again.
            // Advertise afresh whenever nobody is connected after a failure.
            if state == .notConnected && session.connectedPeers.isEmpty {
                advertiser.stopAdvertisingPeer(); advertiser.startAdvertisingPeer()
                onLog?("restarted advertising after a dropped connection")
            }
            if state == .connected {
                send(.hello(Hello(role: "mac", device: device, lastSnapshotVersion: snapshot?.version ?? 0, unacked: 0)), to: peerID)
            }
        }
    }

    public func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        DispatchQueue.main.async { [self] in
            guard let m = try? Message.open(data, with: key) else { onLog?("dropped unreadable message from \(peerID.displayName)"); return }
            switch m {
            case .hello: if let s = snapshot { send(.snapshot(s), to: peerID) }
            case .checkin(let c): onCheckin?(c, peerID.displayName)
            case .snapshot, .ack: break
            }
        }
    }

    public func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String, fromPeer peerID: MCPeerID) {}
    public func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, with progress: Progress) {}
    public func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String, fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}
