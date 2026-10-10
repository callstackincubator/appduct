import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

void main() {
  group('backgrounding', () {
    test(
      'closes the socket with 1001 app_backgrounded and keeps the lease',
      () async {
        final h = Harness();
        final socket = await h.claim();

        h.core.background();
        await settle();

        expect(socket.closedByCore, (code: 1001, reason: 'app_backgrounded'));
        expect(h.core.state, ClientState.reconnecting);
        expect(h.store.value, contains('"resumeToken":"resume-1"'));
      },
    );

    test(
      'does not report the deliberate close as an error or end the session',
      () async {
        final h = Harness();
        await h.claim();

        h.core.background();
        await settle();

        expect(h.errors, isEmpty);
        expect(h.sessions, hasLength(1));
      },
    );

    test('does nothing when the session is not active', () async {
      final h = Harness();

      h.core.background();
      await settle();

      expect(h.transport.sockets, isEmpty);
      expect(h.states, isEmpty);
    });

    test('backgrounding twice closes the socket once', () async {
      final h = Harness();
      final socket = await h.claim();

      h.core.background();
      h.core.background();
      await settle();

      expect(
        h.states.where((s) => s.state == ClientState.reconnecting),
        hasLength(1),
      );
      expect(socket.closedByCore?.code, 1001);
    });
  });

  group('foregrounding', () {
    test('does nothing when the app was never backgrounded', () async {
      final h = Harness();
      await h.claim();

      h.core.foreground();
      await settle();

      expect(h.transport.sockets, hasLength(1));
      expect(h.core.state, ClientState.active);
    });

    test('resumes only once when called twice', () async {
      final h = Harness();
      await h.claim(graceS: 120);
      h.core.background();
      await settle();

      h.core.foreground();
      h.core.foreground();
      await settle();

      expect(h.transport.sockets, hasLength(2));
    });
  });

  test(
    'a session left in the background past its grace window is reported lost',
    () async {
      final h = Harness();
      await h.claim(graceS: 120);
      h.core.background();
      await settle();

      h.clock.advance(120000);
      await settle();

      expect(h.states.last.reason, 'grace_expired');
      expect(h.sessions.last.type, SessionChangeType.lost);
    },
  );
}
