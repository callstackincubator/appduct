import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';

import '../support/harness.dart';

/// A v2 bootstrap link to [address] (4 or 16 raw bytes), well inside its lifetime.
String linkTo(List<int> address, {String pin = ''}) {
  final family = address.length == 4 ? 0x04 : 0x06;
  final id = utf8.encode('session-1');
  final expires = ByteData(8)..setUint64(0, 4000000000);
  final bytes = <int>[
    0x02, family, ...address, 0x20, 0xfb, id.length, ...id, //
    ...List.filled(32, 1), ...expires.buffer.asUint8List(),
  ];
  final payload = base64Url.encode(bytes).replaceAll('=', '');
  return 'myapp:///?appduct=$payload';
}

void main() {
  group('private address check', () {
    for (final (name, address) in <(String, List<int>)>[
      ('192.168.1.10', [192, 168, 1, 10]),
      ('10.0.0.1', [10, 0, 0, 1]),
      ('172.16.0.1', [172, 16, 0, 1]),
      ('127.0.0.1', [127, 0, 0, 1]),
      ('::1', [...List.filled(15, 0), 1]),
      ('fd00::1', [0xfd, ...List.filled(14, 0), 1]),
      ('fe80::1', [0xfe, 0x80, ...List.filled(13, 0), 1]),
    ]) {
      test('connects to the local address $name', () async {
        final h = Harness();

        expect(h.core.handleUrl(linkTo(address)), isTrue);
        await settle();

        expect(h.errors, isEmpty);
        expect(h.transport.sockets, hasLength(1));
      });
    }

    for (final (name, address) in <(String, List<int>)>[
      ('8.8.8.8', [8, 8, 8, 8]),
      ('172.32.0.1', [172, 32, 0, 1]),
      ('2001:db8::1', [0x20, 0x01, 0x0d, 0xb8, ...List.filled(11, 0), 1]),
    ]) {
      test(
        'rejects the public address $name without opening a socket',
        () async {
          final h = Harness();

          expect(h.core.handleUrl(linkTo(address)), isTrue);
          await settle();

          expect(h.errors.single.phase, 'bootstrap');
          expect(h.transport.sockets, isEmpty);
        },
      );
    }
  });
}
