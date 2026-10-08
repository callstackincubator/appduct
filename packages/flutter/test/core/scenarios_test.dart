import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// Replays `packages/native/fixtures/session-scenarios.json` and
/// `session-scenarios-background.json` through the Dart core, the way the web, Swift and Kotlin
/// suites replay them. The format is documented in `packages/native/fixtures/README.md`.

typedef Step = Map<String, Object?>;
typedef Output = Map<String, Object?>;
typedef Scenario = ({
  String name,
  int startMs,
  double random,
  List<Step> steps,
});

List<Scenario> loadScenarios(String file) {
  final raw = jsonDecode(File('../native/fixtures/$file').readAsStringSync());
  return [
    for (final item in (raw as List).cast<Map<String, Object?>>())
      (
        name: item['name']! as String,
        startMs: item['startMs']! as int,
        random: (item['random']! as num).toDouble(),
        steps: (item['steps']! as List).cast<Step>(),
      ),
  ];
}

bool deepEquals(Object? a, Object? b) =>
    jsonEncode(_sorted(a)) == jsonEncode(_sorted(b));

Object? _sorted(Object? value) {
  if (value is Map) {
    final keys = value.keys.cast<String>().toList()..sort();
    return {for (final key in keys) key: _sorted(value[key])};
  }
  if (value is List) return [for (final item in value) _sorted(item)];
  return value;
}

/// Plays every step of [scenario] against a fresh core. Throws on the first output that is
/// missing, comes in the wrong order or differs, and on any output left when the steps run out.
Future<void> replay(Scenario scenario) async {
  final clock = ManualClock(scenario.startMs);
  final transport = MemoryTransport();
  final core = createDartCore(
    DartCorePorts(
      transport: transport,
      sessionStore: MemorySessionStore(),
      clock: clock,
      random: FixedRandom(scenario.random),
      device: device,
    ),
  );
  final toolHost = ToolHost(core);

  final wire = <Output>[];
  final app = <Output>[];
  core.stateChanges.listen(
    (e) => app.add({
      'kind': 'state',
      'state': e.state.name,
      if (e.reason != null) 'reason': e.reason,
    }),
  );
  core.sessionChanges.listen(
    (e) => app.add({
      'kind': 'session',
      'type': e.type.name,
      if (e.reason != null) 'reason': e.reason,
    }),
  );
  core.toolCancels.listen(
    (e) => app.add({'kind': 'cancel', 'call': e.id, 'reason': e.reason}),
  );
  core.toolCalls.listen(
    (e) => app.add({'kind': 'call', 'name': e.name, 'args': e.args}),
  );

  // Opens each socket the core made since the last look, which makes the core send its first
  // frame, and turns that frame into the `connect` output. Every later frame is a `send` output,
  // and a close the core asked for with 1001 app_backgrounded is a `suspend`.
  final seen = <MemorySocket, int>{};
  final suspended = <MemorySocket>{};
  void collectWire() {
    for (final socket in transport.sockets) {
      var count = seen[socket];
      if (count == null) {
        socket.open();
        final first = socket.frames().first;
        wire.add({
          'kind': 'connect',
          'mode': first['type'] == 'session_resume' ? 'resume' : 'claim',
          'sessionId': first['session_id'],
          if (first['resume_token'] is String)
            'resumeToken': first['resume_token'],
        });
        count = 1;
      }
      final frames = socket.frames();
      for (; count! < frames.length; count++) {
        wire.add({'kind': 'send', 'frame': frames[count]});
      }
      seen[socket] = count;
      final closed = socket.closedByCore;
      if (closed != null &&
          closed.code == 1001 &&
          closed.reason == 'app_backgrounded' &&
          suspended.add(socket)) {
        wire.add({'kind': 'suspend'});
      }
    }
  }

  MemorySocket latest() => transport.sockets.last;

  Future<void> drive(Step step) async {
    switch (step['drive']) {
      case 'connect':
        unawaited(
          core
              .connect(
                ConnectInput(
                  ip: '127.0.0.1',
                  port: 49152,
                  sessionId: step['sessionId']! as String,
                  token: step['token']! as String,
                  expiresAt: step['expiresAt']! as int,
                ),
              )
              .then<void>((_) {}, onError: (Object _) {}),
        );
      case 'receive':
        latest().receive(step['frame']!);
      case 'close':
        latest().closeFromDaemon(
          step['code'] as int?,
          step['reason'] as String?,
        );
      case 'drop':
        latest().drop();
      case 'advance':
        clock.advance(step['ms']! as int);
      case 'background':
        core.background();
      case 'foreground':
        core.foreground();
      case 'registerTool':
        // The scenario answers the call with a `respond` step, so the handler never finishes.
        toolHost.register(
          step['descriptor']! as Map<String, Object?>,
          (args, _) => Completer<Object?>().future,
        );
      case 'respond':
        // Answers through the core, as the fixture says "answers the call with that id".
        final error = step['error'] as Map<String, Object?>?;
        core.respondToToolCall(
          step['call']! as String,
          result: step['result'],
          error: error == null
              ? null
              : ToolFailure(
                  error['type']! as String,
                  error['message']! as String,
                ),
        );
      case 'disconnect':
        await core.disconnect();
      default:
        throw StateError('unknown drive step "${step['drive']}"');
    }
    await settle();
    collectWire();
  }

  final channels = {
    'connect': wire,
    'send': wire,
    'suspend': wire,
    'state': app,
    'session': app,
    'call': app,
    'cancel': app,
  };

  Future<void> expectOutput(Step step, String label) async {
    final channel = channels[step['expect']];
    if (channel == null) {
      throw StateError('$label: unknown expect step "${step['expect']}"');
    }
    final wanted = <String, Object?>{
      'kind': step['expect'],
      for (final entry in step.entries)
        if (entry.key != 'expect') entry.key: entry.value,
    };
    collectWire();
    if (channel.isEmpty) {
      throw StateError(
        '$label: expected ${jsonEncode(wanted)} but nothing arrived',
      );
    }
    final got = channel.removeAt(0);
    if (!deepEquals(got, wanted)) {
      throw StateError(
        '$label: expected ${jsonEncode(wanted)} but got ${jsonEncode(got)}',
      );
    }
  }

  for (final (index, step) in scenario.steps.indexed) {
    final label = '${scenario.name}, step ${index + 1}';
    if (step.containsKey('drive')) {
      await drive(step);
    } else {
      await expectOutput(step, label);
    }
  }

  await settle();
  collectWire();
  final leftover = [...wire, ...app];
  if (leftover.isNotEmpty) {
    throw StateError(
      '${scenario.name}: the steps ran out with outputs left over: ${jsonEncode(leftover)}',
    );
  }
}

void main() {
  void replays(String file, {String? skip}) {
    group(file, () {
      final scenarios = skip == null ? loadScenarios(file) : <Scenario>[];

      test('has scenarios', () {
        expect(scenarios, isNotEmpty);
      }, skip: skip);

      for (final scenario in scenarios) {
        test('replays: ${scenario.name}', () => replay(scenario));
      }
    });
  }

  replays('session-scenarios.json');
  replays(
    'session-scenarios-background.json',
    skip:
        File(
          '../native/fixtures/session-scenarios-background.json',
        ).existsSync()
        ? null
        : 'the file arrives with #206 (PR #215); the Dart core replays it as soon as it is on main',
  );

  group('the scenario runner', () {
    final ackFrame = ack(graceS: 10);
    final claimThenActive = <Step>[
      {
        'drive': 'connect',
        'sessionId': sessionId,
        'token': 'claim-token',
        'expiresAt': startMs ~/ 1000 + 300,
      },
      {'expect': 'connect', 'mode': 'claim', 'sessionId': sessionId},
      {'expect': 'state', 'state': 'connecting'},
      {'drive': 'receive', 'frame': ackFrame},
      {'expect': 'state', 'state': 'active'},
      {'expect': 'session', 'type': 'claimed'},
    ];
    final snapshot = <String, Object?>{
      'expect': 'send',
      'frame': {
        'tools': <Object?>[],
        'session_id': sessionId,
        'type': 'tool_registry_snapshot',
      },
    };
    Scenario inline(List<Step> steps) =>
        (name: 'inline', startMs: startMs, random: 0.5, steps: steps);

    test('passes a scenario whose frame keys are in another order', () async {
      await replay(inline([...claimThenActive, snapshot]));
    });

    test(
      'fails a scenario that expects an output the core never produces',
      () async {
        final missing = inline([
          ...claimThenActive,
          snapshot,
          {'expect': 'state', 'state': 'closed'},
        ]);

        await expectLater(
          replay(missing),
          throwsA(
            predicate(
              (e) =>
                  '$e'.contains('step 8') && '$e'.contains('nothing arrived'),
            ),
          ),
        );
      },
    );

    test(
      'fails a scenario that leaves an output the core produced unexpected',
      () async {
        await expectLater(
          replay(inline(claimThenActive)),
          throwsA(
            predicate(
              (e) =>
                  '$e'.contains('outputs left over') &&
                  '$e'.contains('tool_registry_snapshot'),
            ),
          ),
        );
      },
    );

    test(
      'fails a scenario that expects two outputs of one channel in the wrong order',
      () async {
        final swapped = inline([
          ...claimThenActive.take(2),
          {'expect': 'state', 'state': 'active'},
          {'expect': 'state', 'state': 'connecting'},
          ...claimThenActive.skip(3),
        ]);

        await expectLater(
          replay(swapped),
          throwsA(predicate((e) => '$e'.contains('step 3'))),
        );
      },
    );
  });
}
