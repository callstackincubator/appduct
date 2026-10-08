import 'package:appduct/src/core/core.dart';
import 'package:flutter/foundation.dart';
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

  group('a hot restart that sees the link the session started from', () {
    Future<BindingHarness> connected(BindingHarness first) async {
      await first.start();
      final done = first.appduct.connect(appductLink());
      await flush();
      await first.acceptLast();
      await done;
      return first;
    }

    BindingHarness restart(
      BindingHarness first, {
      Map<String, String> environment = const {},
    }) => BindingHarness(
      shim: first.shim,
      transport: first.transport,
      clock: first.clock,
      environment: environment,
    );

    Future<void> expectResumed(BindingHarness restarted) async {
      expect(restarted.appduct.state.value, ClientState.reconnecting);
      expect(restarted.transport.sockets, hasLength(2));
      expect(restarted.shim.lease, isNotNull);
      await restarted.acceptLast();
      expect(restarted.appduct.state.value, ClientState.active);
    }

    testWidgets('resumes instead of reusing the defaultRouteName link', (
      tester,
    ) async {
      tester.platformDispatcher.defaultRouteNameTestValue = appductLink();
      addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
      final first = await connected(BindingHarness());
      final restarted = restart(first);
      await restarted.start();

      await expectResumed(restarted);
    });

    test('resumes instead of reusing the APPDUCT_LINK link', () async {
      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      addTearDown(() => debugDefaultTargetPlatformOverride = null);
      final first = await connected(
        BindingHarness(environment: {'APPDUCT_LINK': appductLink()}),
      );
      final restarted = restart(
        first,
        environment: {'APPDUCT_LINK': appductLink()},
      );
      await restarted.start();

      await expectResumed(restarted);
    });

    test('resumes instead of reusing a link the shim still holds', () async {
      final first = await connected(BindingHarness());
      first.shim.links = [appductLink()];
      final restarted = restart(first);
      await restarted.start();

      await expectResumed(restarted);
    });
  });
}
