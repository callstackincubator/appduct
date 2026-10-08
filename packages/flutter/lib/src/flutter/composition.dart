import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../core/core.dart';
import '../io/io.dart';
import 'ports.dart';

/// `--dart-define=APPDUCT_ALLOW_PRIVATE_LAN_ONLY=false` lets a link point at a public address.
const _allowPrivateLanOnly = bool.fromEnvironment(
  'APPDUCT_ALLOW_PRIVATE_LAN_ONLY',
  defaultValue: true,
);

/// The real ports. The only place the binding reaches the process environment, the clock and the
/// isolate. The parameters default to the real process; tests narrow them to one platform.
BindingPorts productionPorts({
  Map<String, String>? environment,
  bool? isWindows,
  bool? isLinux,
}) {
  final env = environment ?? Platform.environment;
  final windows = isWindows ?? Platform.isWindows;
  final linux = isLinux ?? Platform.isLinux;
  return BindingPorts(
    transport: IoTransport(TrustPolicy.fromEnvironment()),
    clock: SystemClock(),
    random: Random(),
    environment: env,
    isRootIsolate: () => RootIsolateToken.instance != null,
    warn: debugPrint,
    allowPrivateLanOnly: _allowPrivateLanOnly,
    leaseStore: windows || linux
        ? FileSessionStore(
            appName: _appName(),
            environment: env,
            isWindows: windows,
          )
        : null,
  );
}

String _appName() {
  final path = Platform.resolvedExecutable.split(RegExp(r'[/\\]')).last;
  return path.isEmpty ? 'app' : path;
}
