import 'package:appduct/src/core/core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../support/binding_harness.dart';
import '../support/fake_shim.dart';

/// What the Flutter engine sends when Android or iOS opens the app with [location].
Future<void> pushFromPlatform(WidgetTester tester, String location) async {
  final message = const JSONMethodCodec().encodeMethodCall(
    MethodCall('pushRouteInformation', {'location': location, 'state': null}),
  );
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'flutter/navigation',
    message,
    (_) {},
  );
  await tester.pumpAndSettle();
}

GoRouter makeRouter() => GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (_, _) => const Text('home'),
      routes: [
        GoRoute(
          path: 'orders/:id',
          builder: (_, s) => Text('order ${s.pathParameters['id']}'),
        ),
      ],
    ),
  ],
);

String locationOf(GoRouter r) =>
    r.routerDelegate.currentConfiguration.uri.toString();

void main() {
  testWidgets(
    'a link pushed to go_router connects and leaves the route where it was',
    (tester) async {
      final h = BindingHarness();
      final appduct = await h.start();
      final router = makeRouter();
      await tester.pumpWidget(MaterialApp.router(routerConfig: router));
      router.go('/orders/42');
      await tester.pumpAndSettle();

      await pushFromPlatform(tester, appductLink());
      await h.acceptLast();

      expect(appduct.state.value, ClientState.active);
      expect(locationOf(router), '/orders/42');
    },
  );

  testWidgets('a link pushed to a plain Navigator app raises no route error', (
    tester,
  ) async {
    final h = BindingHarness();
    final appduct = await h.start();
    await tester.pumpWidget(
      MaterialApp(
        routes: {
          '/': (_) => const Text('home'),
          '/orders': (_) => const Text('orders'),
        },
      ),
    );
    tester.state<NavigatorState>(find.byType(Navigator)).pushNamed('/orders');
    await tester.pumpAndSettle();

    await pushFromPlatform(tester, appductLink());
    await h.acceptLast();

    expect(tester.takeException(), isNull);
    expect(find.text('orders'), findsOneWidget);
    expect(appduct.state.value, ClientState.active);
  });

  testWidgets('an ordinary app link still reaches the router', (tester) async {
    final h = BindingHarness();
    await h.start();
    final router = makeRouter();
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));

    await pushFromPlatform(tester, '/orders/7');

    expect(locationOf(router), '/orders/7');
    expect(h.transport.sockets, isEmpty);
  });

  testWidgets(
    'a cold-start link in defaultRouteName connects and the app starts at home',
    (tester) async {
      tester.platformDispatcher.defaultRouteNameTestValue = appductLink();
      addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
      final h = BindingHarness();
      final appduct = await h.start();
      await h.acceptLast();

      await tester.pumpWidget(MaterialApp.router(routerConfig: makeRouter()));

      expect(appduct.state.value, ClientState.active);
      expect(find.text('home'), findsOneWidget);
    },
  );

  test('a link the shim lists at activation connects', () async {
    final h = BindingHarness(shim: FakeShim(links: [appductLink()]));
    final appduct = await h.start();
    await h.acceptLast();

    expect(appduct.state.value, ClientState.active);
  });

  test('a link the shim pushes while running connects', () async {
    final h = BindingHarness();
    final appduct = await h.start();

    await h.shim.pushLink(appductLink());
    await h.acceptLast();

    expect(appduct.state.value, ClientState.active);
  });

  testWidgets(
    'a link delivered by both the shim and the route guard connects once',
    (tester) async {
      final h = BindingHarness();
      await h.start();
      await tester.pumpWidget(MaterialApp.router(routerConfig: makeRouter()));
      final link = appductLink();

      await h.shim.pushLink(link);
      await pushFromPlatform(tester, link);
      await h.acceptLast();

      expect(h.transport.sockets, hasLength(1));
    },
  );
}
