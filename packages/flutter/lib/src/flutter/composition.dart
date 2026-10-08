import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/core.dart';
import 'ports.dart';

/// The real ports. The only place the binding reaches the process environment, the clock and the
/// isolate.
BindingPorts productionPorts() => BindingPorts(
  transport: const _PendingTransport(),
  clock: _SystemClock(),
  random: Random(),
  environment: Platform.environment,
  isRootIsolate: () => RootIsolateToken.instance != null,
  warn: debugPrint,
);

/// Stands where the `dart:io` transport goes. It fails every connect, so a build before that
/// adapter is wired reports the missing transport instead of hanging.
class _PendingTransport implements Transport {
  const _PendingTransport();

  @override
  Socket open(Uri url, String? pin, SocketEvents events) =>
      throw UnsupportedError('The dart:io transport is not wired yet.');
}

class _SystemClock implements Clock {
  @override
  int now() => DateTime.now().millisecondsSinceEpoch;

  @override
  TimerHandle setTimeout(void Function() run, int ms) =>
      Timer(Duration(milliseconds: ms), run);

  @override
  void clearTimeout(TimerHandle handle) => (handle as Timer).cancel();
}
