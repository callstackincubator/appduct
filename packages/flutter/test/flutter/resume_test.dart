import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';

void main() {
  test(
    'after a hot restart the session resumes from the shim lease without a link',
    () async {
      final first = BindingHarness();
      await first.start();
      final done = first.appduct.connect(appductLink());
      await flush();
      await first.acceptLast();
      await done;
      expect(first.shim.lease, isNotNull);

      // A new Dart binding over the same native memory and the same daemon.
      final restarted = BindingHarness(
        shim: first.shim,
        transport: first.transport,
        clock: first.clock,
      );
      await restarted.start();

      expect(restarted.shim.activations, 2);
      expect(restarted.transport.sockets, hasLength(2));
      expect(restarted.appduct.state.value, ClientState.reconnecting);
      await restarted.acceptLast();
      expect(restarted.appduct.state.value, ClientState.active);
    },
  );

  test('a start with no lease and no link stays idle', () async {
    final h = BindingHarness();
    final appduct = await h.start();

    expect(appduct.state.value, ClientState.idle);
    expect(h.transport.sockets, isEmpty);
  });
}
