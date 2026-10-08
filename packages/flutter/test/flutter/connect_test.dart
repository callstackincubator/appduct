import 'package:appduct/src/core/core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';

void main() {
  test('connect(link) connects', () async {
    final h = BindingHarness();
    final appduct = await h.start();

    final done = appduct.connect(appductLink());
    await flush();
    await h.acceptLast();
    await done;

    expect(appduct.state.value, ClientState.active);
    expect(h.transport.sockets.single.url.host, '192.168.1.10');
  });

  test('connect(link) rejects text that is not an Appduct link', () async {
    final h = BindingHarness();
    final appduct = await h.start();

    expect(appduct.connect('myapp:///home'), throwsA(isA<AppductException>()));
  });

  test('disconnect() closes the session', () async {
    final h = BindingHarness();
    final appduct = await h.start();
    final done = appduct.connect(appductLink());
    await flush();
    await h.acceptLast();
    await done;

    await appduct.disconnect();

    expect(appduct.state.value, ClientState.closed);
  });

  test('APPDUCT_LINK connects at startup on a desktop debug build', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final h = BindingHarness(environment: {'APPDUCT_LINK': appductLink()});
    final appduct = await h.start();
    await h.acceptLast();

    expect(appduct.state.value, ClientState.active);
  });

  test('APPDUCT_LINK is ignored on a phone', () async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    final h = BindingHarness(environment: {'APPDUCT_LINK': appductLink()});
    await h.start();

    expect(h.transport.sockets, isEmpty);
  });

  group('lifecycle', () {
    Future<BindingHarness> active() async {
      final h = BindingHarness();
      await h.start();
      final done = h.appduct.connect(appductLink());
      await flush();
      await h.acceptLast();
      await done;
      return h;
    }

    test('pausing the app closes the session with app_backgrounded', () async {
      final h = await active();

      WidgetsBinding.instance.handleAppLifecycleStateChanged(
        AppLifecycleState.paused,
      );
      await flush();

      expect(h.transport.sockets.single.closedByCore, (
        code: 1001,
        reason: 'app_backgrounded',
      ));
    });

    test('resuming the app reconnects', () async {
      final h = await active();
      WidgetsBinding.instance.handleAppLifecycleStateChanged(
        AppLifecycleState.paused,
      );
      await flush();

      WidgetsBinding.instance.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      );
      await flush();

      expect(h.transport.sockets, hasLength(2));
    });
  });

  test(
    'the session lease is written to the shim and cleared on disconnect',
    () async {
      final h = BindingHarness();
      final appduct = await h.start();
      final done = appduct.connect(appductLink());
      await flush();
      await h.acceptLast();
      await done;
      expect(h.shim.lease, contains('"resumeToken":"resume-1"'));

      await appduct.disconnect();
      await flush();

      expect(h.shim.lease, isNull);
    },
  );
}
