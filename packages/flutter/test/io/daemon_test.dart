// P2: one test against a real daemon. It needs `pnpm build` first (it starts packages/appduct's
// built CLI with `node`) and runs in the Flutter CI job after that step.
import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/daemon.dart';

class _SpyTransport implements Transport {
  _SpyTransport(this._inner);

  final Transport _inner;
  final sockets = <Socket>[];

  @override
  Socket open(Uri url, String? pin, SocketEvents events) {
    final socket = _inner.open(url, pin, events);
    sockets.add(socket);
    return socket;
  }
}

void main() {
  late RealDaemon daemon;
  late Directory leaseDir;
  late AppductCore core;
  late _SpyTransport transport;

  setUp(() {
    daemon = RealDaemon();
    leaseDir = Directory.systemTemp.createTempSync('appduct-lease-');
    transport = _SpyTransport(IoTransport(TrustPolicy.parse()));
    core = createDartCore(
      DartCorePorts(
        transport: transport,
        sessionStore: FileSessionStore(
          appName: 'daemon-test',
          environment: {'XDG_RUNTIME_DIR': leaseDir.path},
          isWindows: false,
        ),
        clock: SystemClock(),
        random: Random(),
        device: ioDeviceFields(),
      ),
    );
  });

  tearDown(() async {
    await core.disconnect();
    await daemon.stop();
    leaseDir.deleteSync(recursive: true);
  });

  test(
    'claims, serves a call, posts an event, drops the socket and resumes against a real daemon',
    () async {
      core.registerTool({
        'name': 'add',
        'description': 'Add two numbers.',
        'input_schema': {
          'type': 'object',
          'properties': {
            'a': {'type': 'number'},
            'b': {'type': 'number'},
          },
        },
      });
      core.registerEvent({
        'name': 'cart.seeded',
        'description': 'The cart was seeded.',
      });
      core.toolCalls.listen((call) {
        final args = call.args;
        core.respondToToolCall(
          call.id,
          result: {'sum': (args['a']! as num) + (args['b']! as num)},
        );
      });

      Future<SessionChangeEvent> next(SessionChangeType type) => core
          .sessionChanges
          .firstWhere((e) => e.type == type)
          .timeout(const Duration(seconds: 20));

      final claimed = next(SessionChangeType.claimed);
      final link = await daemon.mintLink();
      expect(core.handleUrl(link), isTrue);
      await claimed;
      expect(core.state, ClientState.active);

      Future<Object?> callAdd() async {
        final out = await daemon.cli([
          'tools',
          'call',
          'add',
          '--input',
          '{"a":2,"b":3}',
        ]);
        return out;
      }

      expect(await callAdd(), contains('"sum":5'));

      await core.postEvent('cart.seeded', {'items': 3});
      final events = await daemon.cli(['events', 'since', '0']);
      expect(events, contains('cart.seeded'));

      final resumed = next(SessionChangeType.resumed);
      transport.sockets.last.close(1001, 'test_drop');
      await resumed;

      expect(core.state, ClientState.active);
      expect(transport.sockets, hasLength(2));
      expect(await callAdd(), contains('"sum":5'));
    },
    skip: daemonSkip,
    timeout: const Timeout(Duration(seconds: 90)),
  );
}
