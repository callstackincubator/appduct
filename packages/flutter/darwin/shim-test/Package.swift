// swift-tools-version: 5.9
// Runs the shim's Foundation-only unit tests with `swift test` from this directory. The plugin's
// own package needs the Flutter framework from a host app, so it cannot run them.
import PackageDescription

let package = Package(
    name: "shim-test",
    targets: [
        .target(
            name: "ShimState",
            path: "../appduct/Sources/appduct",
            exclude: ["AppductPlugin.swift", "PrivacyInfo.xcprivacy"],
            sources: ["ShimState.swift"]
        ),
        .testTarget(name: "ShimStateTests", dependencies: ["ShimState"]),
    ]
)
