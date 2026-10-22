// swift-tools-version:5.10
// Dependency-free core for the Workshop Check-in iPad app: durable names-only
// check-ins in system SQLite, event-scoped status, sequential delivery and
// recovery export. No UI, no live transport.
import PackageDescription

let package = Package(
    name: "WorkshopCheckInCore",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "WorkshopCheckInCore", targets: ["WorkshopCheckInCore"]),
        .library(name: "WorkshopCheckInUI", targets: ["WorkshopCheckInUI"]),
    ],
    targets: [
        .target(
            name: "WorkshopCheckInCore",
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .testTarget(
            name: "WorkshopCheckInCoreTests",
            dependencies: ["WorkshopCheckInCore", "WorkshopCheckInUI"]
        ),
        .target(name: "WorkshopCheckInUI", dependencies: ["WorkshopCheckInCore"]),
    ]
)
