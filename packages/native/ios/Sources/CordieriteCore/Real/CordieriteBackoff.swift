// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md.
#if CORDIERITE_ENABLED

import Foundation

/// Reconnect backoff bounds (ARCHITECTURE.md §11): 0.5 s floor, 30 s cap, full jitter. Ports
/// `client/backoff.ts` exactly.
public enum CordieriteBackoff {
  public static let baseMs: Double = 500
  public static let capMs: Double = 30_000

  /// AWS-style "full jitter": `random(0, min(cap, base * 2^attempt))`. `attempt` is 0-based (the
  /// first retry after a loss).
  public static func fullJitterMs(
    attempt: Int,
    baseMs: Double = CordieriteBackoff.baseMs,
    capMs: Double = CordieriteBackoff.capMs,
    random: () -> Double = { Double.random(in: 0..<1) }
  ) -> Double {
    let upperBound = min(capMs, baseMs * pow(2, Double(max(attempt, 0))))
    return (random() * upperBound).rounded(.down)
  }
}

#endif
