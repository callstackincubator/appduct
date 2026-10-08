import 'dart:async';
import 'dart:io';

import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/tls_server.dart';

const wrongPin = 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

class Recorder {
  final messages = StreamController<String>.broadcast();
  final opened = Completer<void>();
  final closed = Completer<(int?, String?)>();
  final errors = <String>[];

  late final events = SocketEvents(
    onOpen: opened.complete,
    onMessage: messages.add,
    onClose: (code, reason) => closed.complete((code, reason)),
    onError: errors.add,
  );
}

void main() {
  late TlsServer server;
  setUpAll(() async => server = await TlsServer.start());
  tearDownAll(() => server.stop());
  setUp(() {
    server.requests = 0;
    server.received.clear();
  });

  Uri url() => Uri(scheme: 'wss', host: '127.0.0.1', port: server.port);

  group('IoTransport', () {
    test(
      'opens a wss connection to a daemon whose key matches the link pin',
      () async {
        final rec = Recorder();
        final next = rec.messages.stream.first;

        final socket = IoTransport(
          TrustPolicy.parse(),
        ).open(url(), server.pin, rec.events);
        await rec.opened.future.timeout(const Duration(seconds: 5));
        socket.send('hello');

        expect(await next.timeout(const Duration(seconds: 5)), 'echo:hello');
        socket.close(1000, 'done');
        expect(await rec.closed.future.timeout(const Duration(seconds: 5)), (
          1000,
          'done',
        ));
      },
    );

    test(
      'fails the handshake and sends nothing when the key does not match',
      () async {
        final rec = Recorder();

        IoTransport(TrustPolicy.parse()).open(url(), wrongPin, rec.events);
        final (code, _) = await rec.closed.future.timeout(
          const Duration(seconds: 5),
        );

        expect(code, isNull);
        expect(rec.opened.isCompleted, isFalse);
        expect(rec.errors, isNotEmpty);
        expect(server.requests, 0);
        expect(server.received, isEmpty);
      },
    );

    test('trusts only the embedded pins when the build has them', () async {
      final embeddedMatch = Recorder();
      IoTransport(
        TrustPolicy.parse(pins: server.pin),
      ).open(url(), wrongPin, embeddedMatch.events);
      await embeddedMatch.opened.future.timeout(const Duration(seconds: 5));

      final embeddedMiss = Recorder();
      IoTransport(
        TrustPolicy.parse(pins: wrongPin),
      ).open(url(), server.pin, embeddedMiss.events);
      await embeddedMiss.closed.future.timeout(const Duration(seconds: 5));

      expect(embeddedMiss.opened.isCompleted, isFalse);
      expect(server.requests, 1);
    });

    test('refuses to open without a pin to check when trust is "link"', () {
      expect(
        () => IoTransport(
          TrustPolicy.parse(),
        ).open(url(), null, Recorder().events),
        throwsA(isA<TrustConfigError>()),
      );
    });

    test('reports a bad trust setting when it opens, not when it is built', () {
      final transport = IoTransport.resolving(
        () => TrustPolicy.parse(trust: 'pinn'),
      );

      expect(
        () => transport.open(url(), server.pin, Recorder().events),
        throwsA(isA<TrustConfigError>()),
      );
    });

    test('closes with 1008 when the daemon sends a binary frame', () async {
      final rec = Recorder();
      final socket = IoTransport(
        TrustPolicy.parse(),
      ).open(url(), server.pin, rec.events);
      await rec.opened.future.timeout(const Duration(seconds: 5));

      socket.send('binary');

      expect(await rec.closed.future.timeout(const Duration(seconds: 5)), (
        1008,
        'binary_frame_not_supported',
      ));
    });

    test('send throws once the socket is closed', () async {
      final rec = Recorder();
      final socket = IoTransport(
        TrustPolicy.parse(),
      ).open(url(), server.pin, rec.events);
      await rec.opened.future.timeout(const Duration(seconds: 5));
      socket.close(1000, 'done');
      await rec.closed.future.timeout(const Duration(seconds: 5));

      expect(() => socket.send('late'), throwsA(isA<StateError>()));
    });

    test('accepts a keepalive interval on an open socket', () async {
      final rec = Recorder();
      final socket = IoTransport(
        TrustPolicy.parse(),
      ).open(url(), server.pin, rec.events);
      await rec.opened.future.timeout(const Duration(seconds: 5));

      expect(
        () => socket.keepalive(const Duration(seconds: 15)),
        returnsNormally,
      );
      socket.close(1000, 'done');
    });
  });

  test('the host machine has openssl for the TLS fixture', () {
    expect(Process.runSync('openssl', ['version']).exitCode, 0);
  });
}
