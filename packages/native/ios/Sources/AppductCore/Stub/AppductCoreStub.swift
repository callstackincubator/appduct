#if !APPDUCT_ENABLED

import Foundation

// Not vendored into @appduct/react-native: `scripts/sync-native-core.mjs` only copies `Real/`,
// since the RN pod always compiles with `-DAPPDUCT_ENABLED` set (see `Appduct.podspec`). This
// file exists purely so the `AppductCore` SwiftPM package itself compiles in a configuration
// that does not define `APPDUCT_ENABLED` (a plain `swift build -c release`, and any future native
// SwiftPM consumer app that links this package into a Release build without the `AlwaysEnabled`
// trait) -- the exact declarations `AppductTurboBridge.swift` calls today, all no-ops, so code
// written against the real implementation still type-checks here unchanged.
//
// `AppductCoreMarker` (Real/AppductCoreMarker.swift) is deliberately NOT declared here: its
// entire purpose is to be a doctor-detectable signal that only ever exists in the real
// implementation. A stub copy would defeat that.

enum AppductConnectionState: String {
  case idle
  case connecting
  case active
  case closed
  case error
}

struct AppductErrorDetails: Sendable {
  let code: String
  let message: String
  let phase: String
  let nativeCode: String?
  let closeReason: String?
  let isRetryable: Bool?
  let hint: String?
}

/// Same shape as the real implementation's initializer, so JS-bridge-style option dictionaries still
/// parse the same way; unlike the real type, a stub build never actually attempts a connection with
/// the result.
struct AppductConnectOptions: Sendable {
  init(_ value: [String: Any]) throws {
    // No-op: a stub build never validates or uses connect options.
  }
}

/// The small diagnostic surface exposed to JS via `getConstants()`. `trust: "excluded"` is a value no
/// real trust resolution (`"pin"`/`"link"`/an echoed invalid string) ever produces, so a caller can
/// tell a stub build's build config apart from a real one's at a glance -- deliberately documented
/// here rather than left to guesswork, matching the equivalent choice documented for Android's
/// `core-noop` module.
struct AppductBuildConfig: Equatable {
  let trust: String
  let hasEmbeddedPins: Bool
  let allowPrivateLanOnly: Bool
}

func currentAppductBuildConfig() -> AppductBuildConfig {
  AppductBuildConfig(trust: "excluded", hasEmbeddedPins: false, allowPrivateLanOnly: true)
}

/// No-op mirror of the real `AppductConnectionManager`: every method matches the real actor's
/// public signature and does nothing. `getState()`/`currentStateSnapshot()` always reports `"idle"`
/// (never `"connecting"`/`"active"`) since a stub build never attempts a connection at all -- the
/// same choice the JS `/noop` entry documents for `getAppductState()`.
actor AppductConnectionManager: NSObject {
  nonisolated(unsafe) var emitStateChange: ((String) -> Void)?
  nonisolated(unsafe) var emitMessageRaw: ((String) -> Void)?
  nonisolated(unsafe) var emitError: ((AppductErrorDetails) -> Void)?
  nonisolated(unsafe) var emitClose: ((NSDictionary) -> Void)?

  override init() {
    super.init()
  }

  func connect(options: AppductConnectOptions) async throws {
    // No-op.
  }

  func send(message: String) async throws {
    // No-op.
  }

  func close() async {
    // No-op.
  }

  func invalidate() {
    // No-op.
  }

  nonisolated func currentStateSnapshot() -> String {
    AppductConnectionState.idle.rawValue
  }

  nonisolated func currentResumeLeaseRecord() -> NSDictionary? {
    nil
  }

  @discardableResult
  nonisolated func clearResumeLease() -> Bool {
    true
  }
}

#endif
