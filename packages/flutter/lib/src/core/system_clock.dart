import 'dart:async';

import 'ports.dart';

/// The real [Clock]: wall time and `dart:async` timers.
class SystemClock implements Clock {
  @override
  int now() => DateTime.now().millisecondsSinceEpoch;

  @override
  TimerHandle setTimeout(void Function() run, int ms) =>
      Timer(Duration(milliseconds: ms), run);

  @override
  void clearTimeout(TimerHandle handle) => (handle as Timer).cancel();
}
