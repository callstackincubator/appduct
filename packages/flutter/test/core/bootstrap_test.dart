import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/fixtures.dart';

void main() {
  final payloads = loadVectors('bootstrap-payloads.json');

  group('bootstrap-payloads.json', () {
    for (final vector in payloads) {
      final name = vector['name']! as String;
      final expected = vector['expected'] as Map<String, Object?>?;

      test(name, () {
        final decoded = decodeBootstrap(vector['base64url']! as String);

        if (expected == null) {
          expect(decoded, isNull);
          return;
        }

        expect(decoded, isNotNull);
        expect(decoded!.family, expected['family']);
        expect(decoded.address, expected['address']);
        expect(decoded.port, expected['port']);
        expect(decoded.sessionId, expected['sessionId']);
        expect(decoded.token, expected['tokenBase64url']);
        expect(decoded.expiresAt, expected['expiresAt']);
      });
    }
  });

  group('decodeBootstrap', () {
    test('rejects text that is not base64url', () {
      expect(decodeBootstrap('not base64!'), isNull);
    });

    test('rejects an empty string', () {
      expect(decodeBootstrap(''), isNull);
    });
  });

  group('bootstrap-links.json', () {
    for (final vector in loadVectors('bootstrap-links.json')) {
      final expected = vector['expected']! as Map<String, Object?>;

      test(vector['name']! as String, () {
        final link = parseBootstrapLink(vector['url']! as String);

        expect(link, isNotNull);
        final payloadIndex = expected['payloadIndex']! as int;
        expect(link!.payload, payloads[payloadIndex]['base64url']);
        expect(link.pin, expected['pin']);
      });
    }
  });

  group('parseBootstrapLink', () {
    test('returns null for a link without an appduct parameter', () {
      expect(parseBootstrapLink('myapp:///?pin=sha256/x'), isNull);
    });

    test('returns null for text that is not a URL', () {
      expect(parseBootstrapLink('http://[bad'), isNull);
    });
  });
}
