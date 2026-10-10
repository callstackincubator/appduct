import 'package:appduct/appduct.dart';
// The core's memory fakes live under src/; the playground test drives its tools through them
// the way the daemon would, which the public API alone cannot do.
// ignore: implementation_imports
import 'package:appduct/src/core/core.dart';
// ignore: implementation_imports
import 'package:appduct/src/flutter/appduct.dart' show installAppduct;
// ignore: implementation_imports
import 'package:appduct/src/flutter/ports.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:playground_flutter/playground_app.dart';

import 'support/link.dart';

const _sessionId = 'session-1';

Map<String, Object?> _call(String id, String name, [Object? args]) => {
  'type': 'tool_call',
  'session_id': _sessionId,
  'id': id,
  'name': name,
  'args': args ?? <String, Object?>{},
};

List<Map<String, Object?>> _sent(MemorySocket socket, String type) => [
  for (final frame in socket.frames())
    if (frame['type'] == type) frame,
];

Future<void> _flush() async {
  for (var i = 0; i < 50; i++) {
    await Future<void>.value();
  }
}

/// The playground over the memory transport with an accepted session, as the daemon would see it.
Future<(Appduct, MemorySocket)> _connected() async {
  TestWidgetsFlutterBinding.ensureInitialized();
  // No native shim in a unit test: every shim call is unanswered, so the binding falls back to
  // its defaults.
  TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(
        const MethodChannel('dev.appduct/shim'),
        (call) async => switch (call.method) {
          'activate' => {
            'owner': true,
            'links': <String>[],
            'lease': null,
            'device': {'manufacturer': 'Test', 'model': 'Test', 'os': 'Test'},
          },
          _ => null,
        },
      );
  final transport = MemoryTransport();
  final appduct = installAppduct(
    BindingPorts(
      transport: transport,
      clock: ManualClock(startMs),
      random: const FixedRandom(0.5),
      environment: const {},
      isRootIsolate: () => true,
      warn: (_) {},
      allowPrivateLanOnly: true,
    ),
  );
  await _flush();
  final done = appduct.connect(playgroundLink());
  await _flush();
  transport.sockets.last
    ..open()
    ..receive(ack(sessionId: _sessionId));
  await _flush();
  await done;
  return (appduct, transport.sockets.last);
}

void main() {
  group('registerPlaygroundTools', () {
    test('announces the five demo tools by name', () async {
      final (appduct, socket) = await _connected();
      registerPlaygroundTools(appduct, PlaygroundCounter());
      await _flush();

      final names = {
        for (final f in _sent(socket, 'tool_registry_delta'))
          if (f['operation'] == 'upsert') (f['tool']! as Map)['name'],
      };
      expect(names, {
        'sum',
        'call_count',
        'reset_counter',
        'slow_task',
        'throwing_tool',
      });
    });

    test('announces the same descriptors as the other playgrounds', () async {
      final (appduct, socket) = await _connected();
      registerPlaygroundTools(appduct, PlaygroundCounter());
      await _flush();

      final tools = {
        for (final f in _sent(socket, 'tool_registry_delta'))
          if (f['operation'] == 'upsert')
            (f['tool']! as Map)['name']: f['tool']! as Map,
      };
      const countOut = {
        'type': 'object',
        'properties': {
          'count': {'type': 'number'},
        },
      };
      expect(tools['sum'], {
        'name': 'sum',
        'description': 'Adds two numbers. Counts as a call in call_count.',
        'input_schema': {
          'type': 'object',
          'properties': {
            'a': {'type': 'number'},
            'b': {'type': 'number'},
          },
          'required': ['a', 'b'],
        },
        'output_schema': {
          'type': 'object',
          'properties': {
            'total': {'type': 'number'},
          },
        },
      });
      expect(tools['call_count'], {
        'name': 'call_count',
        'description':
            'Reports how many times the counted tools (sum, slow_task) have run. Read-only.',
        'output_schema': countOut,
        'annotations': {'readOnlyHint': true},
        'group': 'counter',
      });
      expect(tools['reset_counter'], {
        'name': 'reset_counter',
        'description':
            'Resets the call counter to zero. Destructive; a no-op when it is already zero.',
        'output_schema': countOut,
        'annotations': {'destructiveHint': true, 'idempotentHint': true},
        'group': 'counter',
      });
      expect(tools['slow_task'], {
        'name': 'slow_task',
        'description':
            'Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.',
        'output_schema': {
          'type': 'object',
          'properties': {
            'done': {'type': 'boolean'},
          },
        },
        'timeout_ms': 5000,
        'group': 'diagnostics/progress',
      });
      expect(tools['throwing_tool'], {
        'name': 'throwing_tool',
        'description':
            'Always fails with tool_execution_error. Changes nothing.',
        'annotations': {'readOnlyHint': true},
        'group': 'diagnostics',
      });
    });

    test('sum adds its inputs and counts as a call', () async {
      final (appduct, socket) = await _connected();
      final counter = PlaygroundCounter();
      registerPlaygroundTools(appduct, counter);

      socket.receive(_call('c1', 'sum', {'a': 1.5, 'b': 2}));
      await _flush();

      expect(_sent(socket, 'tool_result').single['result'], {'total': 3.5});
      expect(counter.count, 1);
    });

    test('call_count reports the calls so far', () async {
      final (appduct, socket) = await _connected();
      registerPlaygroundTools(appduct, PlaygroundCounter()..bump());

      socket.receive(_call('c1', 'call_count'));
      await _flush();

      expect(_sent(socket, 'tool_result').single['result'], {'count': 1});
    });

    test('reset_counter sets the count back to zero', () async {
      final (appduct, socket) = await _connected();
      final counter = PlaygroundCounter()..bump();
      registerPlaygroundTools(appduct, counter);

      socket.receive(_call('c1', 'reset_counter'));
      await _flush();

      expect(_sent(socket, 'tool_result').single['result'], {'count': 0});
      expect(counter.count, 0);
    });

    test('slow_task reports three progress steps then finishes', () async {
      final (appduct, socket) = await _connected();
      final counter = PlaygroundCounter();
      registerPlaygroundTools(appduct, counter);

      socket.receive(_call('c1', 'slow_task'));
      await Future<void>.delayed(const Duration(milliseconds: 1800));
      await _flush();

      expect(_sent(socket, 'tool_call_progress').map((f) => f['message']), [
        'warming up',
        'almost there',
        'done',
      ]);
      expect(_sent(socket, 'tool_result').single['result'], {'done': true});
      expect(counter.count, 1);
    });

    test('throwing_tool answers tool_execution_error', () async {
      final (appduct, socket) = await _connected();
      registerPlaygroundTools(appduct, PlaygroundCounter());

      socket.receive(_call('c1', 'throwing_tool'));
      await _flush();

      final error = _sent(socket, 'tool_error').single['error']! as Map;
      expect(error['type'], 'tool_execution_error');
      expect(error['message'], 'throwing_tool always fails on purpose.');
    });

    test('declares playground_ping with the contract description', () async {
      final (appduct, socket) = await _connected();
      registerPlaygroundTools(appduct, PlaygroundCounter());
      await _flush();

      final delta = _sent(socket, 'event_registry_delta').single;
      final event = delta['event']! as Map;
      expect(event['name'], 'playground_ping');
      expect(
        event['description'],
        'The Send playground_ping button on the Status screen was pressed.',
      );
      expect((event['payload_schema']! as Map)['required'], ['at']);
    });

    test('the returned function unregisters every tool', () async {
      final (appduct, socket) = await _connected();
      registerPlaygroundTools(appduct, PlaygroundCounter())();

      socket.receive(_call('c1', 'call_count'));
      await _flush();

      expect(_sent(socket, 'tool_result'), isEmpty);
    });
  });

  group('PlaygroundApp', () {
    /// What a test runner reads through accessibility for the element carrying [id].
    String valueOf(WidgetTester tester, String id) =>
        tester.getSemantics(find.bySemanticsIdentifier(id)).label;

    Future<Appduct> launch(WidgetTester tester) async {
      final (appduct, _) = await _connected();
      await tester.pumpWidget(PlaygroundApp(appduct: appduct));
      await tester.pump();
      return appduct;
    }

    testWidgets('shows call-count as the bare integer, 0 at launch', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await launch(tester);

      expect(valueOf(tester, 'call-count'), '0');
      handle.dispose();
    });

    testWidgets('switches screens with tab-tools and tab-status', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await launch(tester);

      await tester.tap(find.bySemanticsIdentifier('tab-status'));
      await tester.pumpAndSettle();
      expect(find.bySemanticsIdentifier('connection-state'), findsOneWidget);

      await tester.tap(find.bySemanticsIdentifier('tab-tools'));
      await tester.pumpAndSettle();
      expect(find.bySemanticsIdentifier('call-count'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('shows connection-state as the lowercase state name', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await launch(tester);
      await tester.tap(find.bySemanticsIdentifier('tab-status'));
      await tester.pumpAndSettle();

      expect(valueOf(tester, 'connection-state'), 'active');
      handle.dispose();
    });

    testWidgets('shows none for last-session-event and last-ping at launch', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await launch(tester);
      await tester.tap(find.bySemanticsIdentifier('tab-status'));
      await tester.pumpAndSettle();

      expect(valueOf(tester, 'last-session-event'), 'none');
      expect(valueOf(tester, 'last-ping'), 'none');
      handle.dispose();
    });

    testWidgets('ping-button posts playground_ping, last-ping shows its at', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      final (appduct, socket) = await _connected();
      await tester.pumpWidget(PlaygroundApp(appduct: appduct));
      await tester.tap(find.bySemanticsIdentifier('tab-status'));
      await tester.pumpAndSettle();

      await tester.tap(find.bySemanticsIdentifier('ping-button'));
      await tester.pump();
      await _flush();

      final event = _sent(socket, 'event').single;
      expect(event['name'], 'playground_ping');
      final at = (event['payload']! as Map)['at'];
      expect(at, isA<int>());
      expect(valueOf(tester, 'last-ping'), '$at');
      handle.dispose();
    });

    testWidgets('counts a sum call on call-count', (tester) async {
      final handle = tester.ensureSemantics();
      final (appduct, socket) = await _connected();
      await tester.pumpWidget(PlaygroundApp(appduct: appduct));
      await tester.pump();

      socket.receive(_call('c1', 'sum', {'a': 1, 'b': 2}));
      await tester.runAsync(_flush);
      await tester.pump();

      expect(valueOf(tester, 'call-count'), '1');
      handle.dispose();
    });

    testWidgets('a scheme:///status link opens Status, session stays active', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      final appduct = await launch(tester);

      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        'flutter/navigation',
        const JSONMethodCodec().encodeMethodCall(
          const MethodCall('pushRouteInformation', {
            'location': 'appduct-flutter:///status',
          }),
        ),
        (_) {},
      );
      await tester.pumpAndSettle();

      expect(find.bySemanticsIdentifier('connection-state'), findsOneWidget);
      expect(valueOf(tester, 'connection-state'), 'active');
      expect(appduct.state.value, AppductState.active);
      handle.dispose();
    });
  });
}
