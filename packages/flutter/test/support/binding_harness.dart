import 'dart:convert';
import 'dart:typed_data';

import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/flutter/appduct.dart';
import 'package:appduct/src/flutter/ports.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_shim.dart';
import 'harness.dart' show ack, sessionId, startMs;

export 'harness.dart' show ack, sessionId, startMs;

/// A well-formed Appduct link for the session in [ack], valid for a minute after [startMs].
String appductLink({
  String scheme = 'myapp',
  String? session,
  List<int> address = const [192, 168, 1, 10],
}) {
  final id = utf8.encode(session ?? sessionId);
  final bytes = BytesBuilder()
    ..add([2, 4, ...address, 0x20, 0xfb, id.length])
    ..add(id)
    ..add(List.filled(32, 7))
    ..add(
      (ByteData(8)..setUint64(0, startMs ~/ 1000 + 60)).buffer.asUint8List(),
    );
  final payload = base64Url.encode(bytes.toBytes()).replaceAll('=', '');
  return '$scheme:///?appduct=$payload';
}

/// The binding over fakes: the shim channel, the memory transport and a manual clock.
class BindingHarness {
  BindingHarness({
    FakeShim? shim,
    this.rootIsolate = true,
    this.environment = const {},
    MemoryTransport? transport,
    ManualClock? clock,
    this.allowPrivateLanOnly = true,
  }) : shim = shim ?? FakeShim(),
       transport = transport ?? MemoryTransport(),
       clock = clock ?? ManualClock(startMs) {
    this.shim.install();
  }

  final FakeShim shim;
  final MemoryTransport transport;
  final ManualClock clock;
  final bool rootIsolate;
  final bool allowPrivateLanOnly;
  final Map<String, String> environment;
  final warnings = <String>[];
  late final Appduct appduct;

  /// Initialises the binding and lets the activation finish.
  Future<Appduct> start() async {
    appduct = installAppduct(
      BindingPorts(
        transport: transport,
        clock: clock,
        random: const FixedRandom(0.5),
        environment: environment,
        allowPrivateLanOnly: allowPrivateLanOnly,
        isRootIsolate: () => rootIsolate,
        warn: warnings.add,
      ),
    );
    await flush();
    return appduct;
  }

  /// The daemon accepts the newest socket.
  Future<void> acceptLast({String? session}) async {
    transport.sockets.last
      ..open()
      ..receive(ack(session: session));
    await flush();
  }
}

/// Lets pending microtasks run. Unlike `pumpEventQueue` it also works inside `testWidgets`, whose
/// fake zone never fires a zero-length timer.
Future<void> flush() async {
  for (var i = 0; i < 50; i++) {
    await Future<void>.value();
  }
}
