import Foundation

/// FICTIONAL, never connects to a laptop. Lost replies replay the same hash.
public actor FixturePairingTransport: PairingTransport {
    public enum Fault: Sendable { case loseReply, failure(TransportFailure), invalidCode, wrongEvent }
    public let offer: PairingOffer
    private var faults: [Fault]
    private var spentHash: String?
    public private(set) var submittedHashes: [String] = []
    public private(set) var oldProofs: [String?] = []
    public init(offer: PairingOffer, faults: [Fault] = []) { self.offer = offer; self.faults = faults }
    /// The fictional host has no organiser-proof key, so it never proves.
    public func hello(address: ParticipantAddress, code: String,
                      organiserProof: OrganiserProofRequest?) async throws -> PairingHello {
        guard code == "K7QM4TZP" else { throw PairingError.invalidOrExpiredCode }
        return PairingHello(offer: offer)
    }
    public func pair(address: ParticipantAddress, code: String, credentialHash: String,
                     oldDeviceProof: String?) async throws -> PairingSuccess {
        submittedHashes.append(credentialHash); oldProofs.append(oldDeviceProof)
        let fault = faults.isEmpty ? nil : faults.removeFirst()
        if case .failure(let reason) = fault { throw reason }
        if case .invalidCode = fault { throw PairingError.invalidOrExpiredCode }
        guard code == "K7QM4TZP", spentHash == nil || spentHash == credentialHash else {
            throw PairingError.invalidOrExpiredCode
        }
        spentHash = credentialHash
        if case .loseReply = fault { throw TransportFailure.timedOut }
        return PairingSuccess(eventId: faultIsWrongEvent(fault) ? "evt_fixture_other" : offer.eventId,
            deviceId: "dev_fixture_ipad_2", deviceLabel: offer.deviceLabel, credentialHash: credentialHash)
    }
    private func faultIsWrongEvent(_ fault: Fault?) -> Bool { if case .wrongEvent = fault { return true }; return false }
}
