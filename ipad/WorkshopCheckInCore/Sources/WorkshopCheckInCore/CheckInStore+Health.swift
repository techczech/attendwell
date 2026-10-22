import Foundation

extension CheckInStore {
    public func oldestPendingDate(eventId: String) throws -> Date? {
        try locked {
            try db.query("SELECT recorded_at FROM operations WHERE event_id = ? AND state = 'pending' ORDER BY seq LIMIT 1",
                         [.text(eventId)]) { Date(timeIntervalSince1970: $0.double(0)) }.first
        }
    }
}
