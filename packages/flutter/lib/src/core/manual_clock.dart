import 'dart:math';

import 'ports.dart';

/// A [Clock] that only moves when a test says so.
class ManualClock implements Clock {
  ManualClock([int startMs = 0]) : _now = startMs;

  int _now;
  int _nextId = 0;
  final Map<int, ({int at, void Function() run})> _timers = {};

  @override
  int now() => _now;

  @override
  TimerHandle setTimeout(void Function() run, int ms) {
    final id = _nextId++;
    _timers[id] = (at: _now + (ms < 0 ? 0 : ms), run: run);
    return id;
  }

  @override
  void clearTimeout(TimerHandle handle) {
    _timers.remove(handle);
  }

  /// Moves time forward, running every timer that falls due, in order. A timer a running timer
  /// sets for a time inside the window runs too.
  void advance(int ms) {
    final target = _now + ms;
    for (;;) {
      int? dueId;
      ({int at, void Function() run})? due;
      for (final entry in _timers.entries) {
        if (entry.value.at <= target &&
            (due == null || entry.value.at < due.at)) {
          dueId = entry.key;
          due = entry.value;
        }
      }
      if (dueId == null || due == null) break;
      _timers.remove(dueId);
      _now = due.at;
      due.run();
    }
    _now = target;
  }

  /// Timers set and not yet run or cleared.
  int get pendingTimers => _timers.length;
}

/// A [Random] that always answers [value], for tests that need an exact reconnect delay.
class FixedRandom implements Random {
  const FixedRandom(this.value);

  final double value;

  @override
  double nextDouble() => value;

  @override
  int nextInt(int max) => (value * max).floor();

  @override
  bool nextBool() => value >= 0.5;
}
