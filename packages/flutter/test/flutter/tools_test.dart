import 'dart:async';

import 'package:appduct/appduct.dart';
import 'package:appduct/src/core/core.dart' show MemorySocket;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';

Map<String, Object?> toolCall(String id, String name, [Object? args]) => {
  'type': 'tool_call',
  'session_id': sessionId,
  'id': id,
  'name': name,
  'args': args ?? <String, Object?>{},
};

Future<(BindingHarness, MemorySocket)> active() async {
  final h = BindingHarness();
  await h.start();
  final done = h.appduct.connect(appductLink());
  await flush();
  await h.acceptLast();
  await done;
  return (h, h.transport.sockets.last);
}

List<Map<String, Object?>> sent(MemorySocket s, String type) => [
  for (final f in s.frames())
    if (f['type'] == type) f,
];

void main() {
  group('registerTool', () {
    test('serves a call with the handler result', () async {
      final (h, socket) = await active();
      h.appduct.registerTool(
        'sum',
        description: 'Adds.',
        handler: (args, _) => (args['a']! as num) + (args['b']! as num),
      );

      socket.receive(toolCall('c1', 'sum', {'a': 1, 'b': 2}));
      await flush();

      expect(sent(socket, 'tool_result').single['result'], 3);
    });

    test('announces the tool with its schema, timeout and group', () async {
      final (h, socket) = await active();
      h.appduct.registerTool(
        'sum',
        description: 'Adds.',
        inputSchema: {'type': 'object'},
        timeout: const Duration(seconds: 5),
        group: 'math',
        handler: (_, _) => null,
      );
      await flush();

      final delta = sent(socket, 'tool_registry_delta').single.toString();
      expect(delta, contains('timeout_ms: 5000'));
      expect(delta, contains('group: math'));
      expect(delta, contains('input_schema'));
    });

    test('announces the output schema and annotations it was given', () async {
      final (h, socket) = await active();
      h.appduct.registerTool(
        'reset',
        description: 'Resets.',
        outputSchema: {
          'type': 'object',
          'properties': {
            'count': {'type': 'number'},
          },
        },
        destructiveHint: true,
        idempotentHint: true,
        handler: (_, _) => null,
      );
      await flush();

      final tool = sent(socket, 'tool_registry_delta').single['tool']! as Map;
      expect(tool['output_schema'], {
        'type': 'object',
        'properties': {
          'count': {'type': 'number'},
        },
      });
      expect(tool['annotations'], {
        'destructiveHint': true,
        'idempotentHint': true,
      });
    });

    test('announces no annotations when no hint is given', () async {
      final (h, socket) = await active();
      h.appduct.registerTool(
        'plain',
        description: 'Plain.',
        handler: (_, _) => null,
      );
      await flush();

      final tool = sent(socket, 'tool_registry_delta').single['tool']! as Map;
      expect(tool.containsKey('annotations'), isFalse);
      expect(tool.containsKey('output_schema'), isFalse);
    });

    test('the returned function unregisters the tool', () async {
      final (h, socket) = await active();
      final unregister = h.appduct.registerTool(
        'sum',
        description: 'Adds.',
        handler: (_, _) => 1,
      );

      unregister();
      socket.receive(toolCall('c1', 'sum'));
      await flush();

      expect(sent(socket, 'tool_result'), isEmpty);
    });

    test('a throwing handler answers tool_execution_error', () async {
      final (h, socket) = await active();
      h.appduct.registerTool(
        'boom',
        description: 'Fails.',
        handler: (_, _) => throw StateError('nope'),
      );

      socket.receive(toolCall('c1', 'boom'));
      await flush();

      expect(
        (sent(socket, 'tool_error').single['error']! as Map)['type'],
        'tool_execution_error',
      );
    });

    test('context reports progress to the daemon', () async {
      final (h, socket) = await active();
      h.appduct.registerTool(
        'work',
        description: 'Works.',
        handler: (_, context) {
          context.reportProgress(0.5, 'half');
          return null;
        },
      );

      socket.receive(toolCall('c1', 'work'));
      await flush();

      final progress = sent(socket, 'tool_call_progress').single;
      expect(progress['progress'], 0.5);
      expect(progress['message'], 'half');
    });

    test('context tells the handler when the call is cancelled', () async {
      final (h, socket) = await active();
      ToolCallContext? seen;
      final release = Completer<void>();
      h.appduct.registerTool(
        'wait',
        description: 'Waits.',
        handler: (_, context) {
          seen = context;
          return release.future;
        },
      );
      socket.receive(toolCall('c1', 'wait'));
      await flush();
      expect(seen!.isCancelled, isFalse);

      socket.receive({
        'type': 'tool_cancel',
        'session_id': sessionId,
        'id': 'c1',
        'reason': 'client_cancelled',
      });
      await flush();

      expect(seen!.isCancelled, isTrue);
      await seen!.cancelled;
    });
  });

  group('registerEvent and postEvent', () {
    test('send an event on the active session', () async {
      final (h, socket) = await active();
      h.appduct.registerEvent('tick', description: 'Ticks.');

      await h.appduct.postEvent('tick', {'n': 1});

      final event = sent(socket, 'event').single;
      expect(event['name'], 'tick');
      expect(event['payload'], {'n': 1});
    });
  });

  group('AppductTool', () {
    testWidgets('registers while mounted and not again on rebuild', (
      tester,
    ) async {
      final (h, socket) = await active();
      Widget app(String label) => MaterialApp(
        home: AppductTool(
          name: 'screen',
          description: 'The screen.',
          handler: (_, _) => label,
          child: Text(label),
        ),
      );

      await tester.pumpWidget(app('one'));
      await tester.pumpWidget(app('two'));
      await tester.pump();

      expect(
        sent(
          socket,
          'tool_registry_delta',
        ).where((f) => f['operation'] == 'upsert'),
        hasLength(1),
      );
      socket.receive(toolCall('c1', 'screen'));
      await tester.pump();
      await flush();
      expect(sent(socket, 'tool_result').single['result'], 'two');
      expect(h.appduct.state.value, ClientState.active);
    });

    testWidgets('registers again when the description or schema changes', (
      tester,
    ) async {
      final (_, socket) = await active();
      Widget app({
        String name = 'screen',
        String description = 'The screen.',
        Map<String, Object?> schema = const {'type': 'object'},
        Duration? timeout,
        String? group,
      }) => MaterialApp(
        home: AppductTool(
          name: name,
          description: description,
          inputSchema: schema,
          timeout: timeout,
          group: group,
          handler: (_, _) => 1,
          child: const Text('x'),
        ),
      );
      List<String> upserts() => [
        for (final f in sent(socket, 'tool_registry_delta'))
          if (f['operation'] == 'upsert') f.toString(),
      ];

      await tester.pumpWidget(app());
      await tester.pumpWidget(app(description: 'A better screen.'));
      await tester.pumpWidget(
        app(
          description: 'A better screen.',
          schema: {'type': 'object', 'required': <String>[]},
        ),
      );
      await tester.pumpWidget(
        app(
          description: 'A better screen.',
          schema: {'type': 'object', 'required': <String>[]},
          timeout: const Duration(seconds: 3),
          group: 'ui',
        ),
      );
      await tester.pump();
      await flush();

      final all = upserts();
      expect(all, hasLength(4));
      expect(all[1], contains('A better screen.'));
      expect(all[2], contains('required'));
      expect(all.last, contains('timeout_ms: 3000'));
      expect(all.last, contains('group: ui'));
    });

    testWidgets('a changed read-only hint registers the tool again', (
      tester,
    ) async {
      final (_, socket) = await active();
      Widget app({bool? readOnly}) => MaterialApp(
        home: AppductTool(
          name: 'screen',
          description: 'The screen.',
          readOnlyHint: readOnly,
          outputSchema: {'type': 'object'},
          handler: (_, _) => 1,
          child: const Text('x'),
        ),
      );

      await tester.pumpWidget(app());
      await tester.pumpWidget(app(readOnly: true));
      await tester.pump();
      await flush();

      final upserts = [
        for (final f in sent(socket, 'tool_registry_delta'))
          if (f['operation'] == 'upsert') f['tool']! as Map,
      ];
      expect(upserts, hasLength(2));
      expect(upserts.last['annotations'], {'readOnlyHint': true});
      expect(upserts.last['output_schema'], {'type': 'object'});
    });

    testWidgets('an equal schema built again does not register again', (
      tester,
    ) async {
      final (_, socket) = await active();
      Widget app() => MaterialApp(
        home: AppductTool(
          name: 'screen',
          description: 'The screen.',
          inputSchema: {
            'type': 'object',
            'properties': {
              'id': {'type': 'string'},
            },
          },
          handler: (_, _) => 1,
          child: const Text('x'),
        ),
      );

      await tester.pumpWidget(app());
      await tester.pumpWidget(app());
      await tester.pump();

      expect(
        sent(
          socket,
          'tool_registry_delta',
        ).where((f) => f['operation'] == 'upsert'),
        hasLength(1),
      );
    });

    testWidgets('a renamed tool answers under the new name only', (
      tester,
    ) async {
      final (_, socket) = await active();
      Widget app(String name) => MaterialApp(
        home: AppductTool(
          name: name,
          description: 'The screen.',
          handler: (_, _) => name,
          child: const Text('x'),
        ),
      );

      await tester.pumpWidget(app('old'));
      await tester.pumpWidget(app('new'));
      socket
        ..receive(toolCall('c1', 'old'))
        ..receive(toolCall('c2', 'new'));
      await tester.pump();
      await flush();

      final results = sent(socket, 'tool_result');
      expect(results, hasLength(1));
      expect(results.single['result'], 'new');
    });

    testWidgets('unregisters when disposed', (tester) async {
      final (_, socket) = await active();
      await tester.pumpWidget(
        MaterialApp(
          home: AppductTool(
            name: 'screen',
            description: 'The screen.',
            handler: (_, _) => 1,
            child: const Text('x'),
          ),
        ),
      );

      await tester.pumpWidget(const MaterialApp(home: Text('gone')));
      socket.receive(toolCall('c1', 'screen'));
      await tester.pump();
      await flush();

      expect(sent(socket, 'tool_result'), isEmpty);
    });
  });
}
