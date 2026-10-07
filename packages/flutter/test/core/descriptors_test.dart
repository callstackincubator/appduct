import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fixtures.dart';

void main() {
  group('tool-descriptors.json', () {
    for (final vector in loadVectors('tool-descriptors.json')) {
      test(vector['name']! as String, () {
        expect(
          parseToolDescriptor(vector['descriptor']) != null,
          vector['valid'],
        );
      });
    }
  });

  group('event-descriptors.json', () {
    for (final vector in loadVectors('event-descriptors.json')) {
      test(vector['name']! as String, () {
        expect(
          parseEventDescriptor(vector['descriptor']) != null,
          vector['valid'],
        );
      });
    }
  });

  group('tool descriptors', () {
    test('accept a timeout_ms that JSON delivered as a double', () {
      final tool = parseToolDescriptor({
        'name': 'a',
        'description': 'd',
        'timeout_ms': 5000.0,
      });

      expect(tool, isNotNull);
      expect(tool!.timeoutMs, 5000);
    });

    test('keep every field when written back to JSON', () {
      final json = {
        'name': 'sum',
        'description': 'Add two numbers.',
        'input_schema': {'type': 'object'},
        'output_schema': {'type': 'object'},
        'annotations': {'readOnlyHint': true},
        'timeout_ms': 60000,
        'group': 'math/arithmetic',
      };

      expect(parseToolDescriptor(json)!.toJson(), json);
    });

    test('write only the fields that were set', () {
      final json = {'name': 'sum', 'description': 'Add two numbers.'};

      expect(parseToolDescriptor(json)!.toJson(), json);
    });
  });

  group('event descriptors', () {
    test('keep every field when written back to JSON', () {
      final json = {
        'name': 'cart.item_added',
        'description': 'An item went into the cart.',
        'payload_schema': {'type': 'object'},
      };

      expect(parseEventDescriptor(json)!.toJson(), json);
    });
  });
}
