import 'package:appduct/validation.dart';
import 'package:appduct/src/core/core.dart' show MemorySocket;
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';

const schema = {
  'type': 'object',
  'properties': {
    'n': {'type': 'number'},
    'count': {'type': 'integer'},
  },
  'required': ['n'],
  'additionalProperties': false,
};

Future<MemorySocket> activeWithEcho() async {
  final h = BindingHarness();
  await h.start();
  final done = h.appduct.connect(appductLink());
  await flush();
  await h.acceptLast();
  await done;
  h.appduct.registerTool(
    'echo',
    description: 'Echoes the number.',
    inputSchema: schema,
    handler: validated(
      schema,
      (args, _) => {'isNum': args['n'] is num, 'n': args['n']},
    ),
  );
  return h.transport.sockets.last;
}

Future<Map<String, Object?>> call(MemorySocket socket, String argsJson) async {
  socket.receive(
    '{"type":"tool_call","session_id":"$sessionId","id":"c1","name":"echo","args":$argsJson}',
  );
  await flush();
  return socket.frames().last;
}

void main() {
  test(
    'args that do not match the schema answer tool_input_validation_error',
    () async {
      final socket = await activeWithEcho();

      final reply = await call(socket, '{"n":"three"}');

      expect(reply['type'], 'tool_error');
      expect((reply['error']! as Map)['type'], 'tool_input_validation_error');
    },
  );

  test(
    'a missing required argument answers tool_input_validation_error',
    () async {
      final socket = await activeWithEcho();

      final reply = await call(socket, '{}');

      expect((reply['error']! as Map)['type'], 'tool_input_validation_error');
    },
  );

  for (final sent in ['3', '3.0']) {
    test('a number sent as $sent reaches the handler as a num', () async {
      final socket = await activeWithEcho();

      final reply = await call(socket, '{"n":$sent}');

      expect(reply['type'], 'tool_result');
      expect((reply['result']! as Map)['isNum'], isTrue);
      expect((reply['result']! as Map)['n'], 3);
    });
  }

  test('an integer property accepts 3.0', () async {
    final socket = await activeWithEcho();

    final reply = await call(socket, '{"n":1,"count":3.0}');

    expect(reply['type'], 'tool_result');
  });
}
