// Vendored into @appduct/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if APPDUCT_ENABLED

import Foundation

/// RFC 6455 "policy violation". Every daemon-side rejection that a `session_resume` (or
/// `session_claim`) can never talk its way out of closes with this code -- see
/// `client/terminal-close.ts` for the full rationale, ported verbatim here.
public let appductPolicyViolationCloseCode = 1008

public struct AppductCloseEvent: Sendable, Equatable {
  public let code: Int?
  public let reason: String?
  public init(code: Int?, reason: String?) {
    self.code = code
    self.reason = reason
  }
}

/// Whether the daemon closed with a rejection that no retry of the same frame could ever satisfy.
public func isTerminalCloseEvent(_ event: AppductCloseEvent) -> Bool {
  event.code == appductPolicyViolationCloseCode
}

/// The `sessionChange: lost` reason to report for a terminal close -- the daemon's own wire reason
/// when it sent one.
public func terminalCloseReason(_ event: AppductCloseEvent) -> String {
  event.reason ?? "rejected_by_daemon"
}

/// Rejection of an in-flight claim/resume handshake caused by the socket closing, carrying the
/// close event itself -- mirrors `AppductHandshakeClosedError` in `client/terminal-close.ts`.
public struct AppductHandshakeClosedError: Error, Sendable {
  public let message: String
  public let closeEvent: AppductCloseEvent
  /// The socket closed because the daemon's key was not a trusted pin. A claim does not retry that.
  public let pinRejected: Bool
  public init(message: String, closeEvent: AppductCloseEvent, pinRejected: Bool = false) {
    self.message = message
    self.closeEvent = closeEvent
    self.pinRejected = pinRejected
  }
}

/// A connect that failed because the socket did, before it opened (refused, reset during TLS, timed
/// out). The transport throws this from `connect(options:)` so the client can tell it from a
/// refusal it must not retry, such as a bad build setting.
public struct AppductSocketConnectError: Error, Sendable {
  public let underlying: any Error
  public init(underlying: any Error) {
    self.underlying = underlying
  }
}

/// Whether the transport reported the daemon's key as not a trusted pin, or could not check it.
func isPinRejection(_ details: AppductErrorDetails?) -> Bool {
  guard let details, details.phase == "tls", let nativeCode = details.nativeCode else { return false }
  return ["pin_mismatch", "spki_pin_failed", "server_trust_unavailable"].contains(nativeCode)
}

public func isTerminalHandshakeRejection(_ error: Error) -> Bool {
  guard let handshakeError = error as? AppductHandshakeClosedError else { return false }
  return isTerminalCloseEvent(handshakeError.closeEvent)
}

#endif
