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

    test(
      'reconnects nothing while backgrounded, even past the backoff cap',
      () async {
        final h = Harness();
        await h.claim(graceS: 120);
        h.core.background();
        await settle();

        h.clock.advance(31000);

        expect(h.transport.sockets, hasLength(1));
      },
    );

    test('cancels a call in flight with session_suspended', () async {
      final h = Harness();
      h.core.registerTool({'name': 'slow', 'description': 'Waits.'});
      final socket = await h.claim(graceS: 120);
      socket.receive({
        'type': 'tool_call',
        'session_id': sessionId,
        'id': 'c1',
        'name': 'slow',
        'args': <String, Object?>{},
      });

      h.core.background();
      await settle();

      expect(h.toolCancels.single.reason, 'session_suspended');
    });

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
    test(
      'resumes at once with the stored token, without waiting for backoff',
      () async {
        final h = Harness();
        await h.claim(graceS: 120);
        h.core.background();
        await settle();

        h.core.foreground();
        await settle();

        expect(h.transport.sockets, hasLength(2));
        h.last
          ..open()
          ..receive(ack(resumeToken: 'resume-2', graceS: 120));
        await settle();
        expect(h.last.frames().first['resume_token'], 'resume-1');
        expect(h.core.state, ClientState.active);
        expect(h.sessions.last.type, SessionChangeType.resumed);
      },
    );

    test(
      'resumes at once when the app was backgrounded during a backoff wait',
      () async {
        final h = Harness();
        (await h.claim(graceS: 120)).drop();
        await settle();
        h.core.background();
        h.clock.advance(31000);
        expect(h.transport.sockets, hasLength(1));

        h.core.foreground();
        await settle();

        expect(h.transport.sockets, hasLength(2));
      },
    );

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
