import 'package:appduct/appduct.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_shim.dart';

void main() {
  test(
    'ensureInitialized is idempotent and instance returns the same object',
    () async {
      final shim = FakeShim()..install();

      final first = Appduct.ensureInitialized();
      final second = Appduct.ensureInitialized();
      await pumpEventQueue();

      expect(second, same(first));
      expect(Appduct.instance, same(first));
      expect(shim.activations, 1);
    },
  );
}
