import AppductCore
import SwiftUI

/// A plain SwiftUI app consuming `AppductCore` directly -- no React Native, no Expo -- mirroring /
//the API sketch in issue #48 phase 3. Compare with / `playground/` (the Expo app): same five tools,
//same deep-link flow, but wired through / `Appduct.shared` instead of `@appduct/react-native`.
@main
struct AppductPlaygroundApp: App {
  init() {
    PlaygroundTools.registerAll()
    PlaygroundViewModel.shared.start()
  }

  var body: some Scene {
    WindowGroup {
      ContentView()
        .onOpenURL { url in
          // `handle(_:)` returns `true` iff `url` carried an Appduct bootstrap payload; the
          // playground uses the `false` case for its own link: `<scheme>:///status` opens the Status
          // screen, as the playground contract says. A plain `Bool` return (rather than a thrown
          // error) is exactly what lets an app compose this with its own, unrelated deep links --
          // see packages/native/ios/README.md#2-forward-deep-links.
          if !Appduct.shared.handle(url), url.path == "/status" {
            PlaygroundViewModel.shared.screen = .status
          }
        }
    }
  }
}
