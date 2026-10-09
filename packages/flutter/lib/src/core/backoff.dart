import 'dart:math';

const _baseMs = 500;
const _capMs = 30000;

/// Reconnect delay with full jitter: `random * min(30 s, 500 ms * 2^attempt)`. [attempt] counts
/// from 0 for the first retry after a loss. Same schedule as the Swift, Kotlin and web cores.
int fullJitterBackoffMs(int attempt, Random random) {
  final ceiling = min(_capMs, _baseMs * (1 << min(max(attempt, 0), 7)));
  return (random.nextDouble() * ceiling).floor();
}
