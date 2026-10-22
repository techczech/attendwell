import Foundation

/// Time sources the store needs. Inject a fake in tests.
public protocol CheckInClock: Sendable {
    /// Device wall clock; may be wrong or change at any time.
    func wallNow() -> Date
    /// Seconds since boot, including sleep; only comparable within one boot.
    func monotonicSeconds() -> TimeInterval
    /// Identifies the current boot; changes after a reboot.
    func bootID() -> String
}

/// System clock: wall time, a monotonic clock that keeps counting during sleep,
/// and the kernel boot time as the boot identifier.
public struct SystemClock: CheckInClock {
    public init() {}

    public func wallNow() -> Date { Date() }

    public func monotonicSeconds() -> TimeInterval {
        // On Darwin, CLOCK_MONOTONIC is continuous: it advances while asleep.
        TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
    }

    public func bootID() -> String {
        var bootTime = timeval()
        var size = MemoryLayout<timeval>.size
        var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        guard sysctl(&mib, 2, &bootTime, &size, nil, 0) == 0 else { return "unknown" }
        return "\(bootTime.tv_sec).\(bootTime.tv_usec)"
    }
}

/// The last server-time observation for one event, persisted so it survives relaunch.
struct ClockAnchor {
    var serverTime: Date
    var wallAtSync: Date
    var monotonicAtSync: TimeInterval
    var bootAtSync: String

    /// Within the same boot: last server time plus elapsed monotonic time.
    /// After a reboot (or a monotonic clock that went backwards): device wall
    /// clock plus the offset measured at the last sync.
    func estimatedServerTime(_ clock: CheckInClock) -> Date {
        let monotonic = clock.monotonicSeconds()
        if clock.bootID() == bootAtSync, monotonic >= monotonicAtSync {
            return serverTime.addingTimeInterval(monotonic - monotonicAtSync)
        }
        let offset = serverTime.timeIntervalSince(wallAtSync)
        return clock.wallNow().addingTimeInterval(offset)
    }
}
