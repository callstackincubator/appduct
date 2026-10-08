import 'dart:async';

import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

const slow = {'name': 'slow', 'description': 'Waits.', 'timeout_ms': 5000};

Map<String, Object?> toolCall(
  String id, {
  String name = 'slow',
  Object? args,
}) => {
  'type': 'tool_call',
  'session_id': sessionId,
  'id': id,
  'name': name,
  'args': args ?? <String, Object?>{},
};

Map<String, Object?> toolError(String id, String type, String message) => {
  'type': 'tool_error',
  'session_id': sessionId,
  'id': id,
  'error': {'type': type, 'message': message},
};

/// An active session with the `slow` tool registered.
Future<(Harness, MemorySocket)> active() async {
  final h = Harness();
  h.core.registerTool(slow);
  final socket = await h.claim();
  return (h, socket);
}

/// The frames sent after the claim and the snapshot.
List<Map<String, Object?>> afterSnapshot(MemorySocket socket) =>
    socket.frames().skip(2).toList();

void main() {
  group('a tool call', () {
    test('reaches the app as an event with its arguments', () async {
      final (h, socket) = await active();

      socket.receive(toolCall('c1', args: {'a': 1}));
      await settle();

      expect(h.toolCalls.single.id, 'c1');
      expect(h.toolCalls.single.name, 'slow');
      expect(h.toolCalls.single.args, {'a': 1});
    });

    test('is answered with the app result', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      h.core.respondToToolCall('c1', result: {'ok': true});

      expect(afterSnapshot(socket), [
        {
          'type': 'tool_result',
          'session_id': sessionId,
          'id': 'c1',
          'result': {'ok': true},
        },
      ]);
    });

    test(
      'is answered with a null result when the app returns nothing',
      () async {
        final (h, socket) = await active();
        socket.receive(toolCall('c1'));

        h.core.respondToToolCall('c1');

        expect(afterSnapshot(socket).single['result'], isNull);
        expect(afterSnapshot(socket).single, contains('result'));
      },
    );

    test('is answered tool_not_found for a tool nobody registered', () async {
      final (_, socket) = await active();

      socket.receive(toolCall('c1', name: 'ghost'));
      await settle();

      expect(afterSnapshot(socket), [
        toolError(
          'c1',
          'tool_not_found',
          'Tool "ghost" is not registered in the app.',
        ),
      ]);
    });

    test('is answered with the app failure and its details', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      h.core.respondToToolCall(
        'c1',
        error: const ToolFailure(
          'tool_output_validation_error',
          'Bad output.',
          details: {'field': 'x'},
        ),
      );

      expect(afterSnapshot(socket).single['error'], {
        'type': 'tool_output_validation_error',
        'message': 'Bad output.',
        'details': {'field': 'x'},
      });
    });

    test('is answered tool_execution_error when the failure type is not an app-side error type', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      h.core.respondToToolCall(
        'c1',
        error: const ToolFailure('weird', 'Nope.'),
      );

      expect(
        (afterSnapshot(socket).single['error']! as Map)['type'],
        'tool_execution_error',
      );
    });

    test('forwards progress while in flight', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      h.core.reportToolProgress('c1', progress: 0.5, message: 'Halfway');
      h.core.reportToolProgress('c1');

      expect(afterSnapshot(socket), [
        {
          'type': 'tool_call_progress',
          'session_id': sessionId,
          'id': 'c1',
          'progress': 0.5,
          'message': 'Halfway',
        },
        {'type': 'tool_call_progress', 'session_id': sessionId, 'id': 'c1'},
      ]);
    });

    test('sends no progress for a call that is not in flight', () async {
      final (h, socket) = await active();

      h.core.reportToolProgress('nope', progress: 1);

      expect(afterSnapshot(socket), isEmpty);
    });
  });

  group('the deadline', () {
    test(
      'answers tool_timeout at timeout_ms and tells the app to cancel',
      () async {
        final (h, socket) = await active();
        socket.receive(toolCall('c1'));

        h.clock.advance(4999);
        expect(afterSnapshot(socket), isEmpty);
        h.clock.advance(1);

        expect(afterSnapshot(socket), [
          toolError(
            'c1',
            'tool_timeout',
            'Tool "slow" did not respond within 5000ms.',
          ),
        ]);
        expect(h.toolCancels.single.id, 'c1');
        expect(h.toolCancels.single.reason, 'timeout');
      },
    );

    test('uses ten seconds for a tool without timeout_ms', () async {
      final h = Harness();
      h.core.registerTool({'name': 'plain', 'description': 'x'});
      final socket = await h.claim();
      socket.receive(toolCall('c1', name: 'plain'));

      h.clock.advance(9999);
      expect(afterSnapshot(socket), isEmpty);
      h.clock.advance(1);

      expect(
        (afterSnapshot(socket).single['error']! as Map)['type'],
        'tool_timeout',
      );
    });

    test('is cancelled by a result, so no timeout follows', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      h.core.respondToToolCall('c1', result: 1);

      h.clock.advance(60000);

      expect(afterSnapshot(socket).map((f) => f['type']), ['tool_result']);
    });
  });

  group('tool_cancel', () {
    test('answers tool_cancelled and tells the app', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      socket.receive({
        'type': 'tool_cancel',
        'session_id': sessionId,
        'id': 'c1',
        'reason': 'client_cancelled',
      });
      await settle();

      expect(afterSnapshot(socket), [
        toolError('c1', 'tool_cancelled', 'Tool "slow" was cancelled.'),
      ]);
      expect(h.toolCancels.single.reason, 'client_cancelled');
    });

    test('is ignored for an unknown call', () async {
      final (h, socket) = await active();

      socket.receive({
        'type': 'tool_cancel',
        'session_id': sessionId,
        'id': 'nope',
        'reason': 'client_cancelled',
      });
      await settle();

      expect(afterSnapshot(socket), isEmpty);
      expect(h.toolCancels, isEmpty);
    });
  });

  group('a late result', () {
    test('after a timeout puts nothing on the wire', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      h.clock.advance(5000);
      final sent = socket.sent.length;

      h.core.respondToToolCall('c1', result: {'ok': true});
      h.core.reportToolProgress('c1', progress: 1);

      expect(socket.sent, hasLength(sent));
    });

    test('after a cancel puts nothing on the wire', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      socket.receive({
        'type': 'tool_cancel',
        'session_id': sessionId,
        'id': 'c1',
        'reason': 'client_cancelled',
      });
      await settle();
      final sent = socket.sent.length;

      h.core.respondToToolCall('c1', result: {'ok': true});

      expect(socket.sent, hasLength(sent));
    });

    test('a second answer to the same call puts nothing on the wire', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      h.core.respondToToolCall('c1', result: 1);
      final sent = socket.sent.length;

      h.core.respondToToolCall('c1', result: 2);

      expect(socket.sent, hasLength(sent));
    });
  });

  group('when the socket closes with a call in flight', () {
    test('the app is told the call was cancelled with session_suspended and nothing is sent', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      socket.drop();
      await settle();

      expect(h.toolCancels.single.id, 'c1');
      expect(h.toolCancels.single.reason, 'session_suspended');
      expect(afterSnapshot(socket), isEmpty);
      expect(h.core.state, ClientState.reconnecting);
    });

    test('reports the new state before the cancel', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      final order = <String>[];
      h.core.stateChanges.listen((e) => order.add('state:${e.state.name}'));
      h.core.toolCancels.listen((e) => order.add('cancel:${e.reason}'));

      socket.drop();
      await settle();

      expect(order, ['state:reconnecting', 'cancel:session_suspended']);
    });

    test('the deadline does not fire after the socket closed', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      socket.drop();
      await settle();

      h.clock.advance(5000);

      expect(h.toolCancels.map((c) => c.reason), ['session_suspended']);
    });

    test('a result after the drop puts nothing on the next socket', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));
      socket.drop();
      await settle();
      h.clock.advance(250);
      h.last
        ..open()
        ..receive(ack(resumeToken: 'resume-2'));
      await settle();
      final sent = h.last.sent.length;

      h.core.respondToToolCall('c1', result: 1);

      expect(h.last.sent, hasLength(sent));
    });
  });

  group('a result the core cannot encode', () {
    test('answers tool_serialization_error for a DateTime', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      h.core.respondToToolCall('c1', result: {'at': DateTime(2026)});

      expect(afterSnapshot(socket), [
        toolError(
          'c1',
          'tool_serialization_error',
          'Appduct tool result is not JSON-serializable.',
        ),
      ]);
      expect(h.core.state, ClientState.active);
    });

    test(
      'answers tool_serialization_error for a map with a non-string key',
      () async {
        final (h, socket) = await active();
        socket.receive(toolCall('c1'));

        h.core.respondToToolCall('c1', result: {1: 'one'});

        expect(
          (afterSnapshot(socket).single['error']! as Map)['type'],
          'tool_serialization_error',
        );
      },
    );

    test('answers tool_serialization_error for NaN', () async {
      final (h, socket) = await active();
      socket.receive(toolCall('c1'));

      h.core.respondToToolCall('c1', result: double.nan);

      expect(
        (afterSnapshot(socket).single['error']! as Map)['type'],
        'tool_serialization_error',
      );
    });

    test(
      'still answers the call when the error details cannot be encoded',
      () async {
        final (h, socket) = await active();
        socket.receive(toolCall('c1'));

        h.core.respondToToolCall(
          'c1',
          error: ToolFailure(
            'tool_execution_error',
            'Boom.',
            details: DateTime(2026),
          ),
        );

        expect(afterSnapshot(socket).single['error'], {
          'type': 'tool_execution_error',
          'message': 'Boom.',
        });
      },
    );
  });

  group('a tool host', () {
    Future<(Harness, MemorySocket, ToolHost)> hosted(
      ToolHandler handler,
    ) async {
      final h = Harness();
      final host = ToolHost(h.core)..register(slow, handler);
      addTearDown(host.dispose);
      final socket = await h.claim();
      return (h, socket, host);
    }

    test('answers a call with the handler result', () async {
      final (_, socket, _) = await hosted((args, _) => {'echo': args['v']});

      socket.receive(toolCall('c1', args: {'v': 7}));
      await settle();

      expect(afterSnapshot(socket).single['result'], {'echo': 7});
    });

    test('answers an asynchronous handler when it finishes', () async {
      final done = Completer<String>();
      final (_, socket, _) = await hosted((_, _) => done.future);
      socket.receive(toolCall('c1'));
      await settle();
      expect(afterSnapshot(socket), isEmpty);

      done.complete('later');
      await settle();

      expect(afterSnapshot(socket).single['result'], 'later');
    });

    test(
      'answers tool_serialization_error for a result holding a DateTime',
      () async {
        final (_, socket, _) = await hosted((_, _) => {'at': DateTime(2026)});

        socket.receive(toolCall('c1'));
        await settle();

        expect(
          (afterSnapshot(socket).single['error']! as Map)['type'],
          'tool_serialization_error',
        );
      },
    );

    test('answers tool_execution_error when the handler throws', () async {
      final (_, socket, _) = await hosted((_, _) => throw StateError('boom'));

      socket.receive(toolCall('c1'));
      await settle();

      final error = afterSnapshot(socket).single['error']! as Map;
      expect(error['type'], 'tool_execution_error');
      expect(error['message'], contains('boom'));
    });

    test('answers tool_execution_error when an unawaited future in the handler fails', () async {
      final (_, socket, _) = await hosted((_, _) {
        unawaited(
          Future<void>.delayed(
            Duration.zero,
            () => throw StateError('late boom'),
          ),
        );
        return Completer<Object?>().future;
      });

      socket.receive(toolCall('c1'));
      await Future<void>.delayed(const Duration(milliseconds: 10));

      final error = afterSnapshot(socket).single['error']! as Map;
      expect(error['type'], 'tool_execution_error');
      expect(error['message'], contains('late boom'));
    });

    test('answers with the type of a ToolFailure the handler throws', () async {
      final (_, socket, _) = await hosted(
        (_, _) => throw const ToolFailure(
          'tool_input_validation_error',
          'Bad input.',
        ),
      );

      socket.receive(toolCall('c1'));
      await settle();

      expect(
        (afterSnapshot(socket).single['error']! as Map)['type'],
        'tool_input_validation_error',
      );
    });

    test('tells the handler it was cancelled with the reason', () async {
      late ToolContext seen;
      final (h, socket, _) = await hosted((_, context) {
        seen = context;
        return Completer<Object?>().future;
      });
      socket.receive(toolCall('c1'));
      await settle();

      h.clock.advance(5000);

      expect(await seen.cancelled, 'timeout');
    });

    test('tells the handler it was cancelled with session_suspended when the socket closes', () async {
      late ToolContext seen;
      final (_, socket, _) = await hosted((_, context) {
        seen = context;
        return Completer<Object?>().future;
      });
      socket.receive(toolCall('c1'));
      await settle();

      socket.drop();

      expect(await seen.cancelled, 'session_suspended');
    });

    test('sends the progress a handler reports', () async {
      final (_, socket, _) = await hosted((_, context) {
        context.reportProgress(progress: 0.25, message: 'Starting');
        return Completer<Object?>().future;
      });

      socket.receive(toolCall('c1'));
      await settle();

      expect(afterSnapshot(socket).single, containsPair('progress', 0.25));
    });

    test('puts nothing on the wire for what a handler returns after its call timed out', () async {
      final late = Completer<Object?>();
      final (h, socket, _) = await hosted((_, _) => late.future);
      socket.receive(toolCall('c1'));
      await settle();
      h.clock.advance(5000);
      final sent = socket.sent.length;

      late.complete('too late');
      await settle();

      expect(socket.sent, hasLength(sent));
    });

    test('stops serving a tool once it is unregistered', () async {
      final (h, socket, host) = await hosted((_, _) => 1);
      host.unregister('slow');

      socket.receive(toolCall('c1'));
      await settle();

      expect(
        (afterSnapshot(socket).last['error']! as Map)['type'],
        'tool_not_found',
      );
      expect(h.core.registeredTools, isEmpty);
    });
  });
}
