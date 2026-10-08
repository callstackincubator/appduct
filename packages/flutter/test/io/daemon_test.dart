// P2: one test against a real daemon. It needs `pnpm build` first (it starts packages/appduct's
// built CLI with `node`) and runs in the Flutter CI job after that step.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

final _bin = File('../appduct/bin.js').absolute.path;
final _built = File('../appduct/dist/bin.js').existsSync();

/// Skipped on a developer machine that has not built the daemon; in CI a missing build fails.
final Object _skip = _built || Platform.environment.containsKey('CI')
    ? false
    : 'run `pnpm build` at the repo root to build the daemon first';

class _TimerClock implements Clock {
  @override
  int now() => DateTime.now().millisecondsSinceEpoch;

  @override
  TimerHandle setTimeout(void Function() run, int ms) =>
      Timer(Duration(milliseconds: ms), run);

  @override
  void clearTimeout(TimerHandle handle) => (handle as Timer).cancel();
}

/// Hands out the sockets [IoTransport] opens so the test can cut one.
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
  late Directory stateDir;
  late Directory leaseDir;
  late AppductCore core;
  late _SpyTransport transport;

  Future<Map<String, Object?>> cli(List<String> args) async {
    final result = await Process.run(
      'node',
      [_bin, ...args, '--json'],
      environment: {'APPDUCT_STATE_DIR': stateDir.path},
    );
    return jsonDecode(result.stdout as String) as Map<String, Object?>;
  }

  setUp(() {
    stateDir = Directory.systemTemp.createTempSync('appduct-daemon-');
    leaseDir = Directory.systemTemp.createTempSync('appduct-lease-');
    // The link must point at an address the app can reach, so the daemon advertises loopback.
    File('${stateDir.path}/config.json').writeAsStringSync(
      jsonEncode({'wssPort': 0, 'advertisedIp': '127.0.0.1'}),
    );
    transport = _SpyTransport(IoTransport(TrustPolicy.parse()));
    core = createDartCore(
      DartCorePorts(
        transport: transport,
        sessionStore: FileSessionStore(
          appName: 'daemon-test',
          directory: leaseDir,
        ),
        clock: _TimerClock(),
        random: Random(),
        device: ioDeviceFields(),
      ),
    );
  });

  tearDown(() async {
    await core.disconnect();
    await Process.run(
      'node',
      [_bin, 'daemon', 'stop'],
      environment: {'APPDUCT_STATE_DIR': stateDir.path},
    );
    stateDir.deleteSync(recursive: true);
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
      final minted = await cli(['sessions', 'link', '--scheme', 'appduct-e2e']);
      final link = (minted['data']! as Map)['deepLink']! as String;
      expect(core.handleUrl(link), isTrue);
      await claimed;
      expect(core.state, ClientState.active);

      Future<Object?> callAdd() async {
        final out = await cli([
          'tools',
          'call',
          'add',
          '--input',
          '{"a":2,"b":3}',
        ]);
        return out;
      }

      expect(jsonEncode(await callAdd()), contains('"sum":5'));

      await core.postEvent('cart.seeded', {'items': 3});
      final events = await cli(['events', 'since', '0']);
      expect(jsonEncode(events), contains('cart.seeded'));

      final resumed = next(SessionChangeType.resumed);
      transport.sockets.last.close(1001, 'test_drop');
      await resumed;

      expect(core.state, ClientState.active);
      expect(transport.sockets, hasLength(2));
      expect(jsonEncode(await callAdd()), contains('"sum":5'));
    },
    skip: _skip,
    timeout: const Timeout(Duration(seconds: 90)),
  );
}
