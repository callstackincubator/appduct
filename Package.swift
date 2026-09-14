// swift-tools-version: 6.1
// This manifest lives at the repo root (not under packages/native/) because SwiftPM only resolves
// remote package URL dependencies -- and therefore only lets other projects `.package(url: ...)`
// this repository -- when Package.swift sits at the repository root. `path:` below points into
// packages/native/ios/ so the actual sources stay colocated with the rest of the native core.
import PackageDescription

let package = Package(
  name: "CordieriteCore",
  platforms: [
    .iOS("15.1"),
    .tvOS("15.1"),
    .macOS("12.0"),
  ],
  products: [
    .library(name: "CordieriteCore", targets: ["CordieriteCore"])
  ],
  traits: [
    // Opt-in product for a consumer that wants the real implementation compiled into every
    // configuration, not only `Debug` -- see Decision 2 in docs/tasks/14-native-core-extraction.md
    // for why this is a trait rather than a second product: a second product sharing the same
    // target's sources with a different set of active `#if` branches is not expressible in
    // SwiftPM (a target's sources -- and therefore its compiler defines -- are shared by every
    // product that includes it), so the two "editions" of CordieriteCore differ only in which
    // build settings apply, not in which files are compiled.
    .trait(
      name: "AlwaysEnabled",
      description: "Compile the real implementation in every configuration, not only Debug"
    )
  ],
  targets: [
    .target(
      name: "CordieriteCore",
      path: "packages/native/ios/Sources/CordieriteCore",
      swiftSettings: [
        // Mirrors CocoaPods' `:configurations => ['Debug']` restriction on the same code (Decision
        // 2): Xcode passes `.debug` only for a configuration literally named `Debug`, so a custom
        // configuration name gets neither this nor the trait below by default.
        .define("CORDIERITE_ENABLED", .when(configuration: .debug)),
        // A Release build that still wants the real implementation opts in with
        // `.package(url: ..., traits: ["AlwaysEnabled"])` instead of an environment variable --
        // Xcode's manifest cache and GUI environment make `Context.environment` unreliable outside
        // CI, so a build-time condition on an actual manifest input is the only mechanism that
        // behaves the same from the command line and from Xcode's own build UI.
        .define("CORDIERITE_ENABLED", .when(traits: ["AlwaysEnabled"])),
      ]
    ),
    .testTarget(
      name: "CordieriteCoreTests",
      dependencies: ["CordieriteCore"],
      path: "packages/native/ios/Tests/CordieriteCoreTests"
    ),
  ]
)
