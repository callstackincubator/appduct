import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

void main() {
  group('claiming a session', () {
    test(
      'sends a session_claim with the token and the device fields',
      () async {
        final h = Harness();
        final done = h.core.connect(connectInput(pin: 'sha256/abc'));
        h.last.open();

        expect(h.last.frames(), [
          {
            'type': 'session_claim',
            'protocol_version': 2,
            'session_id': sessionId,
            'token': 'claim-token',
            'device_manufacturer': 'Google',
            'device_model': 'Pixel 9',
            'device_os': 'Android 16',
          },
        ]);
        expect(h.last.url, Uri.parse('wss://192.168.1.10:8443'));
        expect(h.last.pin, 'sha256/abc');
        expect(h.core.state, ClientState.connecting);
        expect(h.core.sessionId, sessionId);

        h.last.receive(ack());
        await done;
      },
    );

    test(
      'goes active on the ack, reports a claimed session and sends a snapshot',
      () async {
        final h = Harness();
        final socket = await h.claim();

        expect(h.core.state, ClientState.active);
        expect(h.states.map((s) => s.state), [
          ClientState.connecting,
          ClientState.active,
        ]);
        expect(h.sessions.single.type, SessionChangeType.claimed);
        expect(h.sessions.single.sessionId, sessionId);
        expect(h.sessions.single.alias, 'pixel');
        expect(socket.frames().last, {
          'type': 'tool_registry_snapshot',
          'session_id': sessionId,
          'tools': <Object?>[],
        });
      },
    );

    test('stores a lease carrying the rotated resume token', () async {
      final h = Harness();
      await h.claim();

      expect(h.store.value, contains('"resumeToken":"resume-1"'));
    });

    test('rejects an expired payload without opening a socket', () async {
      final h = Harness();

      await expectLater(
        h.core.connect(connectInput(expiresAt: startMs ~/ 1000 - 1)),
        throwsA(isA<Exception>()),
      );
      expect(h.transport.sockets, isEmpty);
    });

    test('rejects a second connect while one is active', () async {
      final h = Harness();
      await h.claim();

      await expectLater(
        h.core.connect(connectInput()),
        throwsA(isA<Exception>()),
      );
      expect(h.transport.sockets, hasLength(1));
    });

    test(
      'fails the connect when the daemon closes the socket instead of acking',
      () async {
        final h = Harness();
        final done = h.core.connect(connectInput());
        final failure = expectLater(done, throwsA(isA<Exception>()));
        h.last
          ..open()
          ..closeFromDaemon(1008, 'invalid_token');
        await failure;

        expect(h.core.state, ClientState.closed);
        expect(h.states.last.reason, 'connect_error');
        expect(h.errors.first.phase, 'connect');
      },
    );

    test('closes the socket with 1008 on an ack for another session', () async {
      final h = Harness();
      final done = h.core.connect(connectInput());
      final failure = expectLater(done, throwsA(isA<Exception>()));
      h.last
        ..open()
        ..receive({...ack(), 'session_id': 'other'});
      await failure;

      expect(h.last.closedByCore, (code: 1008, reason: 'invalid_ack'));
    });

    test(
      'hands a bootstrap link to connect and reports whether it was one',
      () async {
        final h = Harness();

        expect(h.core.handleUrl('https://example.com/?x=1'), isFalse);
        expect(h.transport.sockets, isEmpty);
      },
    );

    test(
      'reports a bootstrap link it cannot decode on the error stream',
      () async {
        final h = Harness();

        expect(h.core.handleUrl('myapp:///?appduct=AAAA'), isTrue);
        await settle();

        expect(h.errors.single.phase, 'bootstrap');
        expect(h.transport.sockets, isEmpty);
      },
    );
  });

  group('the tool registry', () {
    test(
      'sends registered tools in the snapshot, dropping stray keys',
      () async {
        final h = Harness();
        h.core.registerTool({
          'name': 'echo',
          'description': 'Echoes.',
          'stray': 1,
          'timeout_ms': 500,
        });
        final socket = await h.claim();

        expect(h.sentOf(socket, 'tool_registry_snapshot').single['tools'], [
          {'name': 'echo', 'description': 'Echoes.', 'timeout_ms': 1000},
        ]);
      },
    );

    test(
      'sends a delta for a tool registered or removed while active',
      () async {
        final h = Harness();
        final socket = await h.claim();

        h.core.registerTool({'name': 'echo', 'description': 'Echoes.'});
        h.core.unregisterTool('echo');
        h.core.unregisterTool('echo');

        expect(socket.frames().skip(1), [
          {
            'type': 'tool_registry_delta',
            'session_id': sessionId,
            'operation': 'upsert',
            'tool': {'name': 'echo', 'description': 'Echoes.'},
          },
          {
            'type': 'tool_registry_delta',
            'session_id': sessionId,
            'operation': 'remove',
            'name': 'echo',
          },
        ]);
      },
    );

    test('rejects an invalid descriptor', () {
      final h = Harness();

      expect(
        () => h.core.registerTool({'name': 'bad name', 'description': 'x'}),
        throwsArgumentError,
      );
      expect(h.core.registeredTools, isEmpty);
    });

    test('keeps a re-registered tool in its place', () {
      final h = Harness();
      h.core.registerTool({'name': 'a', 'description': 'one'});
      h.core.registerTool({'name': 'b', 'description': 'two'});
      h.core.registerTool({'name': 'a', 'description': 'three'});

      expect(h.core.registeredTools.map((t) => '${t.name}:${t.description}'), [
        'a:three',
        'b:two',
      ]);
    });
  });

  group('the event registry', () {
    final event = {'name': 'tapped', 'description': 'A tap.'};

    test(
      'sends no event_registry frame when the ack does not carry event_registry',
      () async {
        final h = Harness();
        h.core.registerEvent(event);
        final socket = await h.claim();
        h.core.registerEvent({...event, 'name': 'later'});

        expect(socket.frames().map((f) => f['type']), [
          'tool_registry_snapshot',
        ]);
      },
    );

    test(
      'sends a snapshot after the tool snapshot, then deltas, when the ack carries event_registry',
      () async {
        final h = Harness();
        h.core.registerEvent(event);
        final socket = await h.claim(eventRegistry: true);
        h.core.registerEvent({...event, 'name': 'later'});
        h.core.unregisterEvent('later');

        expect(socket.frames().skip(1), [
          {
            'type': 'event_registry_snapshot',
            'session_id': sessionId,
            'events': [event],
          },
          {
            'type': 'event_registry_delta',
            'session_id': sessionId,
            'operation': 'upsert',
            'event': {'name': 'later', 'description': 'A tap.'},
          },
          {
            'type': 'event_registry_delta',
            'session_id': sessionId,
            'operation': 'remove',
            'name': 'later',
          },
        ]);
      },
    );
  });

  group('posting events', () {
    test('sends an event frame with the payload and the clock time', () async {
      final h = Harness();
      final socket = await h.claim();

      await h.core.postEvent('tapped', {'x': 1});

      expect(socket.frames().last, {
        'type': 'event',
        'session_id': sessionId,
        'name': 'tapped',
        'payload': {'x': 1},
        'ts': startMs,
      });
    });

    test('throws NotActiveException without a session', () async {
      final h = Harness();

      await expectLater(
        h.core.postEvent('tapped'),
        throwsA(isA<NotActiveException>()),
      );
    });

    test(
      'throws ArgumentError for a payload that is not JSON and sends nothing',
      () async {
        final h = Harness();
        final socket = await h.claim();

        await expectLater(
          h.core.postEvent('tapped', DateTime(2026)),
          throwsArgumentError,
        );
        expect(h.sentOf(socket, 'event'), isEmpty);
      },
    );
  });

  group('after the socket drops', () {
    test('resumes with the stored token after the jittered delay', () async {
      final h = Harness();
      final socket = await h.claim();

      socket.drop();
      await settle();
      expect(h.core.state, ClientState.reconnecting);
      expect(h.sessions, hasLength(1));

      h.clock.advance(249);
      expect(h.transport.sockets, hasLength(1));
      h.clock.advance(1);
      expect(h.transport.sockets, hasLength(2));
      h.last.open();

      expect(h.last.frames().single, {
        'type': 'session_resume',
        'protocol_version': 2,
        'session_id': sessionId,
        'resume_token': 'resume-1',
      });
    });

    test(
      'goes active again on the resume ack and reports a resumed session',
      () async {
        final h = Harness();
        (await h.claim()).drop();
        await settle();
        h.clock.advance(250);
        h.last
          ..open()
          ..receive(ack(resumeToken: 'resume-2'));
        await settle();

        expect(h.core.state, ClientState.active);
        expect(h.sessions.last.type, SessionChangeType.resumed);
        expect(h.store.value, contains('"resumeToken":"resume-2"'));
        expect(h.last.frames().last['type'], 'tool_registry_snapshot');
      },
    );

    test(
      'doubles the delay while resumes keep failing, up to the cap',
      () async {
        final h = Harness();
        (await h.claim()).drop();
        await settle();

        for (final delay in [250, 500, 1000, 2000]) {
          final before = h.transport.sockets.length;
          h.clock.advance(delay - 1);
          expect(h.transport.sockets, hasLength(before));
          h.clock.advance(1);
          expect(h.transport.sockets, hasLength(before + 1));
          h.last
            ..open()
            ..drop();
          await settle();
        }
      },
    );

    test('reports the session lost when the grace window runs out', () async {
      final h = Harness();
      (await h.claim(graceS: 10)).drop();
      await settle();

      h.clock.advance(10000);
      await settle();

      expect(h.core.state, ClientState.closed);
      expect(h.states.last.reason, 'grace_expired');
      expect(h.sessions.last.type, SessionChangeType.lost);
      expect(h.sessions.last.reason, 'grace_expired');
      expect(h.store.value, isNull);
    });

    test(
      'clears the store and reports the session lost when the daemon rejects the resume with 1008',
      () async {
        final h = Harness();
        (await h.claim()).drop();
        await settle();
        h.clock.advance(250);
        h.last
          ..open()
          ..closeFromDaemon(1008, 'invalid_resume_token');
        await settle();

        expect(h.core.state, ClientState.closed);
        expect(h.sessions.last.reason, 'invalid_resume_token');
        expect(h.store.value, isNull);

        h.clock.advance(60000);
        expect(h.transport.sockets, hasLength(2));
      },
    );

    test(
      'reports the session lost at once when the daemon closes with 1000',
      () async {
        final h = Harness();
        (await h.claim()).closeFromDaemon(1000, 'revoked');
        await settle();

        expect(h.states.last.reason, 'revoked');
        expect(h.sessions.last.type, SessionChangeType.lost);
        expect(h.store.value, isNull);
      },
    );

    test(
      'keeps retrying after a resume the daemon closes with a non-terminal code',
      () async {
        final h = Harness();
        (await h.claim()).drop();
        await settle();
        h.clock.advance(250);
        h.last
          ..open()
          ..closeFromDaemon(1011, 'restarting');
        await settle();

        expect(h.core.state, ClientState.reconnecting);
        expect(h.errors.last.phase, 'socket');
        h.clock.advance(500);
        expect(h.transport.sockets, hasLength(3));
      },
    );

    test('retries a resume whose socket could not be opened', () async {
      final h = Harness();
      (await h.claim()).drop();
      await settle();
      h.transport.failNextOpen(StateError('no network'));
      h.clock.advance(250);
      await settle();

      expect(h.core.state, ClientState.reconnecting);
      h.clock.advance(500);
      expect(h.transport.sockets, hasLength(2));
    });
  });

  group('restoring a session after a restart', () {
    test(
      'resumes with the stored token and reports a resumed session',
      () async {
        final h = Harness();
        await h.claim();
        final restarted = h.restart();

        expect(await restarted.core.restoreSession(), isTrue);
        expect(restarted.core.state, ClientState.reconnecting);
        await settle();
        restarted.last.open();
        expect(restarted.last.frames().single['resume_token'], 'resume-1');
        restarted.last.receive(ack(resumeToken: 'resume-2'));
        await settle();

        expect(restarted.core.state, ClientState.active);
        expect(restarted.sessions.single.type, SessionChangeType.resumed);
      },
    );

    test(
      'returns false and leaves the store empty when there is no lease',
      () async {
        final h = Harness();

        expect(await h.core.restoreSession(), isFalse);
        expect(h.transport.sockets, isEmpty);
      },
    );

    test('clears a lease whose grace window has passed', () async {
      final h = Harness();
      (await h.claim(graceS: 10)).drop();
      await settle();
      h.clock.advance(9000);
      final restarted = h.restart();
      h.clock.advance(1000);

      expect(await restarted.core.restoreSession(), isFalse);
      expect(h.store.value, isNull);
    });

    test('clears a stored value that is not a lease', () async {
      final h = Harness();
      h.store.write('{"schemaVersion":1}');

      expect(await h.core.restoreSession(), isFalse);
      expect(h.store.value, isNull);
    });

    test('resumes with the pin the claim carried', () async {
      final h = Harness();
      await h.claim(input: connectInput(pin: 'sha256/abc'));
      final restarted = h.restart();
      await restarted.core.restoreSession();
      await settle();

      expect(restarted.last.pin, 'sha256/abc');
    });
  });

  group('disconnecting', () {
    test(
      'closes the socket with 1000, clears the store and reports the session lost',
      () async {
        final h = Harness();
        final socket = await h.claim();

        await h.core.disconnect();
        await settle();

        expect(socket.closedByCore, (code: 1000, reason: 'client_close'));
        expect(h.core.state, ClientState.closed);
        expect(h.states.last.reason, 'closed_by_app');
        expect(h.sessions.last.type, SessionChangeType.lost);
        expect(h.sessions.last.reason, 'closed_by_app');
        expect(h.store.value, isNull);
        expect(h.core.sessionId, isNull);
      },
    );

    test('stops a reconnect in progress', () async {
      final h = Harness();
      (await h.claim()).drop();
      await settle();

      await h.core.disconnect();
      h.clock.advance(60000);

      expect(h.transport.sockets, hasLength(1));
    });
  });

  group('keepalive', () {
    test('pings on the interval the ack gave', () async {
      final h = Harness();
      final socket = await h.claim();

      h.clock.advance(14999);
      expect(socket.pingCount, 0);
      h.clock.advance(1);
      expect(socket.pingCount, 1);
      h.clock.advance(15000);
      expect(socket.pingCount, 2);
    });

    test('stops pinging once the socket is gone', () async {
      final h = Harness();
      final socket = await h.claim();
      socket.drop();
      await settle();

      h.clock.advance(60000);

      expect(socket.pingCount, 0);
    });

    test(
      'reconnects and resumes after pings go unanswered for a blocked stretch',
      () async {
        final h = Harness();
        final socket = await h.claim();
        socket.failPings = true;

        // The isolate is blocked for a minute: four pings come due at once.
        h.clock.advance(60000);
        await settle();
        expect(socket.closedByCore?.code, 1011);
        await settle();
        expect(h.core.state, ClientState.reconnecting);

        h.clock.advance(250);
        h.last
          ..open()
          ..receive(ack(resumeToken: 'resume-2'));
        await settle();

        expect(h.last.frames().first['type'], 'session_resume');
        expect(h.last.frames().first['resume_token'], 'resume-1');
        expect(h.core.state, ClientState.active);
        expect(h.sessions.last.type, SessionChangeType.resumed);
      },
    );

    test('keeps the socket after a single missed pong', () async {
      final h = Harness();
      final socket = await h.claim();
      socket.failPings = true;
      h.clock.advance(15000);
      await settle();
      socket.failPings = false;
      h.clock.advance(15000);
      await settle();
      socket.failPings = true;
      h.clock.advance(15000);
      await settle();

      expect(socket.closedByCore, isNull);
      expect(h.core.state, ClientState.active);
    });
  });

  group('frames the core refuses', () {
    test(
      'closes with 1008 session_mismatch on a frame for another session',
      () async {
        final h = Harness();
        final socket = await h.claim();

        socket.receive({
          'type': 'tool_cancel',
          'session_id': 'other',
          'id': 'c',
          'reason': 'x',
        });
        await settle();

        expect(socket.closedByCore, (code: 1008, reason: 'session_mismatch'));
        expect(h.sessions.last.reason, 'session_mismatch');
      },
    );

    test('ignores a frame type it does not know', () async {
      final h = Harness();
      final socket = await h.claim();

      socket.receive({'type': 'future_thing', 'session_id': sessionId});
      await settle();

      expect(h.core.state, ClientState.active);
      expect(socket.closedByCore, isNull);
    });
  });
}
