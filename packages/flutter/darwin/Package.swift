// swift-tools-version: 5.9
// Runs the shim's Foundation-only unit tests with `swift test` from this directory. SwiftPM
// refuses target paths outside the package root, so this manifest sits above the sources. The
// plugin's own package, appduct/Package.swift, needs the Flutter framework from a host app, so it
// cannot run them.
import PackageDescription

let package = Package(
    name: "shim-test",
    targets: [
        .target(
            name: "ShimState",
            path: "appduct/Sources/appduct",
            exclude: ["AppductPlugin.swift", "PrivacyInfo.xcprivacy"],
            sources: ["ShimState.swift"]
        ),
        .testTarget(
            name: "ShimStateTests",
            dependencies: ["ShimState"],
            path: "shim-test/Tests/ShimStateTests"
        ),
    ]
)
