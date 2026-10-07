import 'dart:convert';

import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fixtures.dart';

const _sid = 'XzAERP54_Goh74hZ';

final _tool = {
  'name': 'sum',
  'description': 'Add two numbers.',
  'input_schema': {
    'type': 'object',
    'properties': {
      'a': {'type': 'number'},
      'b': {'type': 'number'},
    },
  },
  'timeout_ms': 60000,
  'group': 'math',
};

final _event = {
  'name': 'cart.item_added',
  'description': 'An item went into the cart.',
  'payload_schema': {'type': 'object'},
};

/// One valid frame per message type in docs/PROTOCOL.md section 4, in wire form.
final Map<String, Map<String, Object?>> _frames = {
  'session_claim': {
    'type': 'session_claim',
    'protocol_version': 2,
    'session_id': _sid,
    'token': 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
    'device_manufacturer': 'Apple',
    'device_model': 'iPhone15,2',
    'device_os': 'iOS 18.2',
  },
  'session_claim without device': {
    'type': 'session_claim',
    'protocol_version': 2,
    'session_id': _sid,
    'token': 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE',
  },
  'session_resume': {
    'type': 'session_resume',
    'protocol_version': 2,
    'session_id': _sid,
    'resume_token': 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
  },
  'session_ack': {
    'type': 'session_ack',
    'session_id': _sid,
    'status': 'ok',
    'alias': 'pixel-8',
    'resume_token': 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
    'keepalive_interval_s': 15,
    'grace_s': 600,
    'event_registry': true,
  },
  'session_ack from a daemon without event registries': {
    'type': 'session_ack',
    'session_id': _sid,
    'status': 'ok',
    'alias': 'pixel-8',
    'resume_token': 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
    'keepalive_interval_s': 15,
    'grace_s': 600,
  },
  'tool_registry_snapshot': {
    'type': 'tool_registry_snapshot',
    'session_id': _sid,
    'tools': [_tool],
  },
  'tool_registry_delta upsert': {
    'type': 'tool_registry_delta',
    'session_id': _sid,
    'operation': 'upsert',
    'tool': _tool,
  },
  'tool_registry_delta remove': {
    'type': 'tool_registry_delta',
    'session_id': _sid,
    'operation': 'remove',
    'name': 'sum',
  },
  'event_registry_snapshot': {
    'type': 'event_registry_snapshot',
    'session_id': _sid,
    'events': [_event],
  },
  'event_registry_delta upsert': {
    'type': 'event_registry_delta',
    'session_id': _sid,
    'operation': 'upsert',
    'event': _event,
  },
  'event_registry_delta remove': {
    'type': 'event_registry_delta',
    'session_id': _sid,
    'operation': 'remove',
    'name': 'cart.item_added',
  },
  'tool_call': {
    'type': 'tool_call',
    'session_id': _sid,
    'id': 'call_1',
    'name': 'sum',
    'args': {'a': 2, 'b': 3},
  },
  'tool_result': {
    'type': 'tool_result',
    'session_id': _sid,
    'id': 'call_1',
    'result': {'total': 5},
  },
  'tool_result with a null result': {
    'type': 'tool_result',
    'session_id': _sid,
    'id': 'call_1',
    'result': null,
  },
  'tool_error': {
    'type': 'tool_error',
    'session_id': _sid,
    'id': 'call_1',
    'error': {
      'type': 'tool_execution_error',
      'message': 'Something went wrong',
      'details': {'stack': '...'},
    },
  },
  'tool_error without details': {
    'type': 'tool_error',
    'session_id': _sid,
    'id': 'call_1',
    'error': {'type': 'tool_cancelled', 'message': 'Cancelled'},
  },
  'tool_call_progress': {
    'type': 'tool_call_progress',
    'session_id': _sid,
    'id': 'call_1',
    'progress': 0.5,
    'message': 'Halfway there',
  },
  'tool_call_progress without progress or message': {
    'type': 'tool_call_progress',
    'session_id': _sid,
    'id': 'call_1',
  },
  'tool_cancel': {
    'type': 'tool_cancel',
    'session_id': _sid,
    'id': 'call_1',
    'reason': 'client_cancelled',
  },
  'event': {
    'type': 'event',
    'session_id': _sid,
    'name': 'screen_changed',
    'payload': {'screen': 'Checkout'},
    'ts': 1752600000000,
  },
  'event without payload': {
    'type': 'event',
    'session_id': _sid,
    'name': 'screen_changed',
    'ts': 1752600000000,
  },
};

void main() {
  group('frames', () {
    _frames.forEach((name, json) {
      test('$name round-trips through decode and encode', () {
        final message = decodeFrame(jsonEncode(json));

        expect(message, isNotNull);
        expect(message, isNot(isA<UnknownMessage>()));
        expect(jsonDecode(encodeFrame(message!)), json);
      });
    });

    test('every message type of the protocol has a frame above', () {
      final types = {for (final json in _frames.values) json['type']};

      expect(types, {
        'session_claim',
        'session_resume',
        'session_ack',
        'tool_registry_snapshot',
        'tool_registry_delta',
        'event_registry_snapshot',
        'event_registry_delta',
        'tool_call',
        'tool_result',
        'tool_error',
        'tool_call_progress',
        'tool_cancel',
        'event',
      });
    });

    test('decode exposes the fields of a tool_call', () {
      final message = decodeFrame(jsonEncode(_frames['tool_call']));

      expect(message, isA<ToolCall>());
      final call = message! as ToolCall;
      expect(call.sessionId, _sid);
      expect(call.id, 'call_1');
      expect(call.name, 'sum');
      expect(call.args, {'a': 2, 'b': 3});
    });

    test('encode writes a tool_result for the call it answers', () {
      final json = jsonDecode(
        encodeFrame(ToolResult(sessionId: _sid, id: 'call_7', result: [1, 2])),
      );

      expect(json, {
        'type': 'tool_result',
        'session_id': _sid,
        'id': 'call_7',
        'result': [1, 2],
      });
    });
  });

  group('numbers', () {
    test('a session_ack keepalive that arrives as a double decodes', () {
      final json = {
        ..._frames['session_ack']!,
        'keepalive_interval_s': 15.0,
        'grace_s': 600.0,
      };

      final ack = decodeFrame(jsonEncode(json));

      expect(ack, isA<SessionAck>());
      expect((ack! as SessionAck).keepaliveIntervalS, 15);
    });

    test('an event ts that arrives as a double decodes', () {
      final json = {..._frames['event']!, 'ts': 1752600000000.0};

      expect(decodeFrame(jsonEncode(json)), isA<EventFrame>());
    });

    test('a tool_call_progress progress of 1 decodes as well as 1.0', () {
      final json = {..._frames['tool_call_progress']!, 'progress': 1};

      expect(decodeFrame(jsonEncode(json)), isA<ToolCallProgress>());
    });

    test('a protocol_version of 2.0 is version 2', () {
      final json = {..._frames['session_resume']!, 'protocol_version': 2.0};

      expect(decodeFrame(jsonEncode(json)), isA<SessionResume>());
    });

    test('a non-finite or non-numeric keepalive is rejected', () {
      for (final bad in ['15', null, true]) {
        final json = {..._frames['session_ack']!, 'keepalive_interval_s': bad};

        expect(decodeFrame(jsonEncode(json)), isNull, reason: '$bad');
      }
    });
  });

  group('unknown and malformed frames', () {
    test('an unknown type decodes to a value the core can ignore', () {
      final message = decodeFrame(
        '{"type":"from_the_future","session_id":"$_sid"}',
      );

      expect(message, isA<UnknownMessage>());
      expect((message! as UnknownMessage).type, 'from_the_future');
    });

    test('text that is not JSON decodes to null', () {
      expect(decodeFrame('{nope'), isNull);
    });

    test('JSON that is not an object decodes to null', () {
      expect(decodeFrame('[1,2]'), isNull);
      expect(decodeFrame('"tool_call"'), isNull);
    });

    test('an object without a string type decodes to null', () {
      expect(decodeFrame('{"session_id":"$_sid"}'), isNull);
      expect(decodeFrame('{"type":3}'), isNull);
    });

    test('a known type that fails its field rules decodes to null', () {
      final bad = <String, Map<String, Object?>>{
        'claim with protocol 1': {
          ..._frames['session_claim']!,
          'protocol_version': 1,
        },
        'claim with a device field over 256': {
          ..._frames['session_claim']!,
          'device_os': 'x' * 257,
        },
        'claim with a numeric device field': {
          ..._frames['session_claim']!,
          'device_model': 5,
        },
        'ack with status not ok': {..._frames['session_ack']!, 'status': 'no'},
        'ack with event_registry false': {
          ..._frames['session_ack']!,
          'event_registry': false,
        },
        'tool_call with array args': {..._frames['tool_call']!, 'args': []},
        'tool_call without an id': {..._frames['tool_call']!..remove('id')},
        'tool_result without a result key': {
          ..._frames['tool_result']!..remove('result'),
        },
        'tool_error with an unknown error type': {
          ..._frames['tool_error']!,
          'error': {'type': 'boom', 'message': 'm'},
        },
        'snapshot with an invalid tool': {
          ..._frames['tool_registry_snapshot']!,
          'tools': [
            {'name': 'bad name', 'description': 'd'},
          ],
        },
        'delta with an unknown operation': {
          ..._frames['tool_registry_delta remove']!,
          'operation': 'noop',
        },
        'event with a non-numeric ts': {..._frames['event']!, 'ts': 'now'},
        'cancel without a reason': {
          ..._frames['tool_cancel']!..remove('reason'),
        },
        'session id over 128 characters': {
          ..._frames['tool_cancel']!,
          'session_id': 's' * 129,
        },
      };

      bad.forEach((name, json) {
        expect(decodeFrame(jsonEncode(json)), isNull, reason: name);
      });
    });
  });

  group('event-registry-frames.json', () {
    for (final vector in loadVectors('event-registry-frames.json')) {
      test(vector['name']! as String, () {
        final sessionId = vector['sessionId']! as String;
        final declared = [
          for (final event in vector['declaredBeforeAck']! as List)
            parseEventDescriptor(event)!,
        ];
        final sent = <WireMessage>[
          EventRegistrySnapshot(sessionId: sessionId, events: declared),
        ];

        for (final step
            in (vector['afterAck']! as List).cast<Map<String, Object?>>()) {
          sent.add(switch (step['op']) {
            'register' => EventRegistryUpsert(
              sessionId: sessionId,
              event: parseEventDescriptor(step['event'])!,
            ),
            'remove' => EventRegistryRemove(
              sessionId: sessionId,
              name: step['name']! as String,
            ),
            final op => fail('unknown op $op'),
          });
        }

        expect([
          for (final message in sent) jsonDecode(encodeFrame(message)),
        ], vector['frames']);
        for (final frame in vector['frames']! as List) {
          expect(
            jsonDecode(encodeFrame(decodeFrame(jsonEncode(frame))!)),
            frame,
          );
        }
      });
    }
  });
}
