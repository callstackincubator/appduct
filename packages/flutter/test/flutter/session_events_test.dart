import 'package:appduct/appduct.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';

void main() {
  group('session changes', () {
    test(
      'a claimed link emits claimed with the session id and alias',
      () async {
        final h = BindingHarness();
        final appduct = await h.start();
        final changes = <SessionChangeEvent>[];
        appduct.sessionChanges.listen(changes.add);

        final done = appduct.connect(appductLink());
        await flush();
        await h.acceptLast();
        await done;

        expect(changes, hasLength(1));
        expect(changes.single.type, SessionChangeType.claimed);
        expect(changes.single.sessionId, sessionId);
        expect(changes.single.alias, 'pixel');
        expect(appduct.sessionId, sessionId);
      },
    );

    test('a hot restart emits resumed with the same session id', () async {
      final first = BindingHarness();
      await first.start();
      final done = first.appduct.connect(appductLink());
      await flush();
      await first.acceptLast();
      await done;

      final restarted = BindingHarness(
        shim: first.shim,
        transport: first.transport,
        clock: first.clock,
      );
      final appduct = await restarted.start();
      final changes = <SessionChangeEvent>[];
      appduct.sessionChanges.listen(changes.add);
      await restarted.acceptLast();

      expect(changes.map((c) => c.type), [SessionChangeType.resumed]);
      expect(changes.single.sessionId, sessionId);
      expect(appduct.sessionId, sessionId);
    });

    test(
      'running out of grace emits lost with its reason and clears the session id',
      () async {
        final h = BindingHarness();
        final appduct = await h.start();
        final changes = <SessionChangeEvent>[];
        appduct.sessionChanges.listen(changes.add);
        final done = appduct.connect(appductLink());
        await flush();
        await h.acceptLast();
        await done;

        h.transport.sockets.last.drop();
        await flush();
        h.clock.advance(600 * 1000);
        await flush();

        expect(changes.last.type, SessionChangeType.lost);
        expect(changes.last.reason, 'grace_expired');
        expect(appduct.sessionId, isNull);
      },
    );

    test('has no session id before a link is claimed', () async {
      final appduct = await BindingHarness().start();

      expect(appduct.sessionId, isNull);
    });
  });

  group('errors', () {
    test(
      'a link the daemon rejects emits an error in the connect phase',
      () async {
        final h = BindingHarness();
        final appduct = await h.start();
        final errors = <ErrorEvent>[];
        appduct.errors.listen(errors.add);

        final done = appduct.connect(appductLink());
        final failure = expectLater(done, throwsA(isA<AppductException>()));
        await flush();
        h.transport.sockets.last
          ..open()
          ..closeFromDaemon(1008, 'invalid_token');
        await failure;

        expect(errors, isNotEmpty);
        expect(errors.first.phase, 'connect');
        expect(errors.first.message, isNotEmpty);
      },
    );
  });
}
