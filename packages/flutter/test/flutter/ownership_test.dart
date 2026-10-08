import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';
import '../support/fake_shim.dart';

void main() {
  group('when the shim says another engine owns Appduct', () {
    test('every call is a no-op and one warning is logged', () async {
      final h = BindingHarness(
        shim: FakeShim(owner: false, links: [appductLink()]),
      );
      final appduct = await h.start();

      final unregister = appduct.registerTool(
        'echo',
        description: 'Echoes.',
        handler: (args, _) => args,
      );
      unregister();
      appduct.registerEvent('tick', description: 'Ticks.');
      await appduct.postEvent('tick');
      await appduct.connect(appductLink());
      await appduct.disconnect();
      await h.shim.pushLink(appductLink());
      await pumpEventQueue();

      expect(h.transport.sockets, isEmpty);
      expect(appduct.state.value, ClientState.idle);
      expect(h.warnings, hasLength(1));
      expect(h.shim.calls, isNot(contains('writeLease')));
    });
  });

  group('in a background isolate', () {
    test(
      'it returns the no-op with one warning and never calls activate',
      () async {
        final h = BindingHarness(
          rootIsolate: false,
          shim: FakeShim(links: [appductLink()]),
        );
        final appduct = await h.start();

        await appduct.connect(appductLink());

        expect(h.shim.calls, isEmpty);
        expect(h.transport.sockets, isEmpty);
        expect(appduct.state.value, ClientState.idle);
        expect(h.warnings, hasLength(1));
      },
    );
  });
}
