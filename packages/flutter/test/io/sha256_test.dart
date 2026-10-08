import 'dart:convert';
import 'dart:typed_data';

import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

String hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

void main() {
  group('sha256', () {
    test('hashes the empty input', () {
      expect(
        hex(sha256(Uint8List(0))),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    test('hashes "abc"', () {
      expect(
        hex(sha256(utf8.encode('abc'))),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
    });

    test('hashes a message that spills into a second block', () {
      expect(
        hex(
          sha256(
            utf8.encode(
              'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
            ),
          ),
        ),
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      );
    });

    test('hashes inputs around the padding boundaries', () {
      // Known digests of 55, 56 and 64 bytes of "a" (the lengths where padding changes shape).
      final expected = {
        55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
        56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
        64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      };
      for (final entry in expected.entries) {
        expect(
          hex(sha256(Uint8List(entry.key)..fillRange(0, entry.key, 0x61))),
          entry.value,
          reason: '${entry.key} bytes',
        );
      }
    });

    test('hashes a million "a"', () {
      expect(
        hex(sha256(Uint8List(1000000)..fillRange(0, 1000000, 0x61))),
        'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
      );
    });
  });
}
