import 'dart:convert';
import 'dart:typed_data';

import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fixtures.dart';

void main() {
  final fixture = loadFixture('spki-pin.json')! as Map<String, Object?>;
  final der = base64.decode(fixture['certificateDerBase64']! as String);

  group('spkiPin', () {
    test('returns expectedPin for the spki-pin.json certificate', () {
      expect(spkiPin(der), fixture['expectedPin']);
    });

    test('returns no pin for an empty buffer', () {
      expect(spkiPin(Uint8List(0)), isNull);
    });

    test('returns no pin for a certificate cut off at any length', () {
      for (var length = 0; length < der.length; length++) {
        expect(spkiPin(der.sublist(0, length)), isNull, reason: '$length');
      }
    });

    test('returns no pin for bytes that are not a certificate', () {
      expect(
        spkiPin(Uint8List.fromList(utf8.encode('not a certificate'))),
        isNull,
      );
      expect(spkiPin(Uint8List.fromList(List.filled(64, 0xff))), isNull);
      expect(spkiPin(Uint8List.fromList(List.filled(64, 0))), isNull);
    });

    test('returns no pin for a length that runs past the buffer', () {
      final bad = Uint8List.fromList(der)..[3] = 0xff;
      expect(spkiPin(bad), isNull);
    });

    test('returns no pin for an absurd long-form length', () {
      expect(
        spkiPin(
          Uint8List.fromList([
            0x30,
            0x88,
            0xff,
            0xff,
            0xff,
            0xff,
            0xff,
            0xff,
            0xff,
            0xff,
            1,
          ]),
        ),
        isNull,
      );
    });

    test('never throws on a certificate with any single byte changed', () {
      for (var i = 0; i < der.length; i++) {
        final copy = Uint8List.fromList(der)..[i] ^= 0xff;
        expect(() => spkiPin(copy), returnsNormally, reason: 'byte $i');
      }
    });
  });
}
