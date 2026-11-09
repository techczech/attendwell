// swift-tools-version:5.9
import PackageDescription

// NearbyLink: Multipeer transport and message model shared by the Mac helper and the iPad spike app.
// attendwell-nearby: the Mac helper (and a headless fake iPad for measurement).
let package = Package(
    name: "NearbyLink",
    platforms: [.macOS(.v14), .iOS(.v16)],
    products: [
        .library(name: "NearbyLink", targets: ["NearbyLink"]),
        .executable(name: "attendwell-nearby", targets: ["attendwell-nearby"]),
    ],
    targets: [
        .target(name: "NearbyLink"),
        .executableTarget(
            name: "attendwell-nearby",
            dependencies: ["NearbyLink"], exclude: ["Info.plist"],
            linkerSettings: [
                // Embeds Info.plist so the helper itself carries the Local Network / Bonjour / Bluetooth keys (macOS reads them
                // from the responsible app bundle when launched by it; this covers running the helper on its own).
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                              "-Xlinker", "Sources/attendwell-nearby/Info.plist"]),
            ]
        ),
        .testTarget(name: "NearbyLinkTests", dependencies: ["NearbyLink"]),
    ]
)
