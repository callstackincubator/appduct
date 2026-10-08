import 'dart:math';

import '../core/core.dart';

/// Everything the binding reaches outside the process through, besides the shim channel and the
/// Flutter engine, which tests fake at their own seams.
class BindingPorts {
  const BindingPorts({
    required this.transport,
    required this.clock,
    required this.random,
    required this.environment,
    required this.isRootIsolate,
    required this.warn,
  });

  final Transport transport;
  final Clock clock;

  /// Reconnect jitter.
  final Random random;

  /// The process environment, read for `APPDUCT_LINK` on desktop debug builds.
  final Map<String, String> environment;

  /// Whether this isolate is the root isolate of its engine. A background isolate must not take
  /// the pending link or write the lease.
  final bool Function() isRootIsolate;

  final void Function(String message) warn;
}
