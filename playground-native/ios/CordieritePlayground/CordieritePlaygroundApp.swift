import CordieriteCore
import SwiftUI

/// A plain SwiftUI app consuming `CordieriteCore` directly -- no React Native, no Expo -- mirroring
/// the API sketch in issue #48 phase 3 (`docs/tasks/18-ios-entry-points.md`). Compare with
/// `playground/` (the Expo app): same five tools, same deep-link flow, but wired through
/// `Cordierite.shared` instead of `@cordierite/react-native`.
@main
struct CordieritePlaygroundApp: App {
  init() {
    PlaygroundTools.registerAll()
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .onOpenURL { url in
          // `handle(_:)` returns `true` iff `url` carried a Cordierite bootstrap payload; the
          // playground has nothing else to do with the result here since a plain `Bool` return
          // (rather than a thrown error) is exactly what lets an app compose this with its own,
          // unrelated deep links -- see packages/native/ios/README.md#2-forward-deep-links.
          _ = Cordierite.shared.handle(url)
        }
    }
  }
}
