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
  public init(message: String, closeEvent: AppductCloseEvent) {
    self.message = message
    self.closeEvent = closeEvent
  }
}

public func isTerminalHandshakeRejection(_ error: Error) -> Bool {
  guard let handshakeError = error as? AppductHandshakeClosedError else { return false }
  return isTerminalCloseEvent(handshakeError.closeEvent)
}

#endif
