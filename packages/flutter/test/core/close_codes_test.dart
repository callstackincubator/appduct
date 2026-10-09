import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fixtures.dart';

void main() {
  group('close-codes.json', () {
    for (final vector in loadVectors('close-codes.json')) {
      test('${vector['code']} ${vector['reason']}', () {
        expect(isTerminalClose(vector['code'] as int?), vector['terminal']);
      });
    }
  });

  test('only 1008 is terminal', () {
    final terminal = [
      for (var code = 0; code < 5000; code++)
        if (isTerminalClose(code)) code,
    ];

    expect(terminal, [1008]);
  });
}
