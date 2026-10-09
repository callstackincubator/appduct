import 'dart:convert';

import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fixtures.dart';
import '../support/harness.dart';

const limitBytes = 262144;

int utf8Bytes(String text) => utf8.encode(text).length;

/// A string that makes a frame carrying it exactly [frameBytes] long, given the frame's size
/// with `""` in its place.
String padding(int frameBytes, String filler, int emptyFrameBytes) {
  final pad = frameBytes - emptyFrameBytes;
  final unit = utf8Bytes(filler);
  final count = pad ~/ unit;
  return filler * count + 'a' * (pad - count * unit);
}

Map<String, Object?> toolCall(String id) => {
  'type': 'tool_call',
  'session_id': sessionId,
  'id': id,
  'name': 'big',
  'args': <String, Object?>{},
};

void main() {
  final fixture = loadFixture('frame-limits.json')! as Map<String, Object?>;
  final vectors = (fixture['vectors']! as List)
      .cast<Map<String, Object?>>()
      .map(
        (vector) => (
          name: vector['name']! as String,
          bytes: vector['frameBytes']! as int,
          filler: vector['filler']! as String,
          sent: vector['sent']! as bool,
        ),
      );

  test('frame-limits.json has vectors at the protocol limit', () {
    expect(fixture['limitBytes'], limitBytes);
    expect(vectors, isNotEmpty);
  });

  for (final vector in vectors) {
    group(vector.name, () {
      test(
        'answers a tool result as sent or as tool_serialization_error naming the size, and keeps the session active',
        () async {
          final h = Harness();
          h.core.registerTool({
            'name': 'big',
            'description': 'Returns a string.',
          });
          final socket = await h.claim();
          socket.receive(toolCall('id-a'));
          h.core.respondToToolCall('id-a', result: '');
          final emptyFrameBytes = utf8Bytes(socket.sent.last);

          socket.receive(toolCall('id-b'));
          h.core.respondToToolCall(
            'id-b',
            result: padding(vector.bytes, vector.filler, emptyFrameBytes),
          );

          final results = h.sentOf(socket, 'tool_result');
          if (vector.sent) {
            expect(results.map((f) => f['id']), ['id-a', 'id-b']);
            expect(utf8Bytes(socket.sent.last), vector.bytes);
          } else {
            expect(results.map((f) => f['id']), ['id-a']);
            expect(h.sentOf(socket, 'tool_error'), [
              {
                'type': 'tool_error',
                'session_id': sessionId,
                'id': 'id-b',
                'error': {
                  'type': 'tool_serialization_error',
                  'message':
                      'Appduct frame is ${vector.bytes} bytes, over the $limitBytes-byte limit.',
                },
              },
            ]);
          }
          expect(h.core.state, ClientState.active);
          expect(socket.closedByCore, isNull);
        },
      );

      test(
        'sends an event as is or reports it to the error listener naming the size, and keeps the session active',
        () async {
          final h = Harness();
          final socket = await h.claim();
          await h.core.postEvent('big', '');
          final emptyFrameBytes = utf8Bytes(socket.sent.last);

          await h.core.postEvent(
            'big',
            padding(vector.bytes, vector.filler, emptyFrameBytes),
          );
          await settle();

          if (vector.sent) {
            expect(h.sentOf(socket, 'event'), hasLength(2));
            expect(utf8Bytes(socket.sent.last), vector.bytes);
            expect(h.errors, isEmpty);
          } else {
            expect(h.sentOf(socket, 'event'), hasLength(1));
            expect(h.errors, hasLength(1));
            expect(h.errors.single.phase, 'socket');
            expect(
              h.errors.single.message,
              'Appduct frame is ${vector.bytes} bytes, over the $limitBytes-byte limit.',
            );
          }
          expect(h.core.state, ClientState.active);
          expect(socket.closedByCore, isNull);
        },
      );
    });
  }

  test('a 300 KiB tool result is never sent and fails the call', () async {
    final h = Harness();
    h.core.registerTool({'name': 'big', 'description': 'Returns a string.'});
    final socket = await h.claim();
    socket.receive(toolCall('c1'));

    h.core.respondToToolCall('c1', result: 'x' * (300 * 1024));

    expect(h.sentOf(socket, 'tool_result'), isEmpty);
    final error = h.sentOf(socket, 'tool_error').single['error']! as Map;
    expect(error['type'], 'tool_serialization_error');
    expect(
      error['message'],
      matches(
        RegExp(r'^Appduct frame is \d+ bytes, over the 262144-byte limit\.$'),
      ),
    );
    expect(socket.sent.every((text) => utf8Bytes(text) <= limitBytes), isTrue);
    expect(h.core.state, ClientState.active);
  });

  test(
    'a tool failure over the limit is answered tool_serialization_error, not a timeout',
    () async {
      final h = Harness();
      h.core.registerTool({'name': 'big', 'description': 'Fails hugely.'});
      final socket = await h.claim();
      socket.receive(toolCall('c1'));

      h.core.respondToToolCall(
        'c1',
        error: ToolFailure('tool_execution_error', 'x' * (300 * 1024)),
      );
      h.clock.advance(10000);

      final errors = h.sentOf(socket, 'tool_error');
      expect(errors, hasLength(1));
      final error = errors.single['error']! as Map;
      expect(error['type'], 'tool_serialization_error');
      expect(
        error['message'],
        matches(
          RegExp(r'^Appduct frame is \d+ bytes, over the 262144-byte limit\.$'),
        ),
      );
      expect(error.containsKey('details'), isFalse);
      expect(h.core.state, ClientState.active);
    },
  );

  test(
    'a tool registry snapshot over the limit is reported to the error listener and leaves the session active',
    () async {
      final h = Harness();
      for (var i = 0; i < 70; i++) {
        h.core.registerTool({'name': 'tool_$i', 'description': 'x' * 4096});
      }

      final socket = await h.claim();

      expect(h.sentOf(socket, 'tool_registry_snapshot'), isEmpty);
      expect(h.errors, hasLength(1));
      expect(h.errors.single.phase, 'tool');
      expect(
        h.errors.single.message,
        matches(
          RegExp(r'^Appduct frame is \d+ bytes, over the 262144-byte limit\.$'),
        ),
      );
      expect(h.core.state, ClientState.active);
    },
  );
}
