// Needs the flag off at compile time: flutter test --dart-define=APPDUCT_ENABLED=false
import 'package:appduct/appduct.dart';
import 'package:appduct/src/flutter/enabled.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fake_shim.dart';

void main() {
  final skip = appductEnabled
      ? 'run with --dart-define=APPDUCT_ENABLED=false'
      : false;

  group('a debug build with APPDUCT_ENABLED=false', () {
    test('never asks the native shim to activate', () async {
      final shim = FakeShim(links: ['appduct-link-placeholder'])..install();

      final appduct = Appduct.ensureInitialized();
      appduct.registerTool(
        'echo',
        description: 'Echoes.',
        handler: (args, _) => args,
      );
      appduct.registerEvent('tick', description: 'Ticks.');
      await appduct.postEvent('tick');
      await pumpEventQueue();

      expect(shim.calls, isEmpty);
    }, skip: skip);

    test('opens no connection and stays idle', () async {
      FakeShim().install();

      final appduct = Appduct.ensureInitialized();
      await appduct.connect('appduct-link-placeholder');
      await appduct.disconnect();

      expect(appduct.state.value, AppductState.idle);
    }, skip: skip);

    test('Appduct.instance returns the same inert object', () {
      expect(Appduct.instance, same(Appduct.ensureInitialized()));
    }, skip: skip);
  });
}
