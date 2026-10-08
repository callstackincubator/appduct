import 'package:appduct/appduct.dart';
import 'package:flutter/foundation.dart';

/// The names `registerPlaygroundTools` registers, in the order the Expo playground lists them.
const playgroundToolNames = [
  'sum',
  'call_count',
  'reset_counter',
  'slow_task',
  'throwing_tool',
];

/// How many times the counted tools (`sum`, `slow_task`) have run. The Expo playground keeps this in
/// React state and the native ones in a view model; this is the Flutter equivalent.
class PlaygroundCounter extends ChangeNotifier {
  int _count = 0;

  int get count => _count;

  void bump() {
    _count += 1;
    notifyListeners();
  }

  void reset() {
    _count = 0;
    notifyListeners();
  }
}

/// Registers the same tools and event as `playground` and `playground-native`: same names,
/// descriptions and schemas, so `appduct tools ls` reports an equivalent surface whichever
/// playground answered the link. The returned function unregisters them all.
void Function() registerPlaygroundTools(
  Appduct appduct,
  PlaygroundCounter counter,
) {
  final undo = <void Function()>[
    appduct.registerTool(
      'sum',
      description: 'Adds two numbers. Counts as a call in call_count.',
      inputSchema: {
        'type': 'object',
        'properties': {
          'a': {'type': 'number'},
          'b': {'type': 'number'},
        },
        'required': ['a', 'b'],
      },
      outputSchema: {
        'type': 'object',
        'properties': {
          'total': {'type': 'number'},
        },
      },
      handler: (args, _) {
        counter.bump();
        return {'total': (args['a']! as num) + (args['b']! as num)};
      },
    ),
    appduct.registerTool(
      'call_count',
      description:
          'Reports how many times the counted tools (sum, slow_task) have run. Read-only.',
      outputSchema: {
        'type': 'object',
        'properties': {
          'count': {'type': 'number'},
        },
      },
      readOnlyHint: true,
      group: 'counter',
      handler: (_, _) => {'count': counter.count},
    ),
    appduct.registerTool(
      'reset_counter',
      description:
          'Resets the call counter to zero. Destructive; a no-op when it is already zero.',
      outputSchema: {
        'type': 'object',
        'properties': {
          'count': {'type': 'number'},
        },
      },
      destructiveHint: true,
      idempotentHint: true,
      group: 'counter',
      handler: (_, _) {
        counter.reset();
        return {'count': 0};
      },
    ),
    appduct.registerTool(
      'slow_task',
      description:
          'Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.',
      outputSchema: {
        'type': 'object',
        'properties': {
          'done': {'type': 'boolean'},
        },
      },
      group: 'diagnostics/progress',
      timeout: const Duration(seconds: 5),
      handler: (_, context) async {
        for (final (progress, message) in const [
          (0.33, 'warming up'),
          (0.66, 'almost there'),
          (1.0, 'done'),
        ]) {
          await Future<void>.delayed(const Duration(milliseconds: 500));
          context.reportProgress(progress, message);
        }
        counter.bump();
        return {'done': true};
      },
    ),
    appduct.registerTool(
      'throwing_tool',
      description: 'Always fails with tool_execution_error. Changes nothing.',
      readOnlyHint: true,
      group: 'diagnostics',
      handler: (_, _) =>
          throw StateError('throwing_tool always fails on purpose.'),
    ),
    appduct.registerEvent(
      'playground_ping',
      description:
          'The Send playground_ping button on the Status tab was pressed.',
      payloadSchema: {
        'type': 'object',
        'properties': {
          'at': {
            'type': 'number',
            'description': 'Press time, milliseconds since the epoch',
          },
        },
        'required': ['at'],
      },
    ),
  ];
  return () {
    for (final f in undo) {
      f();
    }
  };
}
