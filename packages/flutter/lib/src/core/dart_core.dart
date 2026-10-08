import 'dart:math';

import 'app_core.dart';
import 'ports.dart';

/// Everything the core reaches outside the process through.
class DartCorePorts {
  const DartCorePorts({
    required this.transport,
    required this.sessionStore,
    required this.clock,
    required this.random,
    required this.device,
  });

  final Transport transport;
  final SessionStore sessionStore;
  final Clock clock;

  /// Reconnect jitter.
  final Random random;
  final DeviceFields device;
}

AppductCore createDartCore(DartCorePorts ports) {
  throw UnimplementedError('createDartCore');
}
