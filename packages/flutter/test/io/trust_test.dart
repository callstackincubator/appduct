import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

const embedded = 'sha256/embedded-pin';
const other = 'sha256/other-pin';
const link = 'sha256/link-pin';

void main() {
  group('TrustPolicy', () {
    test('trust "pin" with embedded pins uses only the embedded pins', () {
      final policy = TrustPolicy.parse(trust: 'pin', pins: '$embedded,$other');

      for (final linkPin in [null, '', link]) {
        expect(policy.pinsFor(linkPin), {embedded, other}, reason: '$linkPin');
      }
    });

    test('trust "pin" with no embedded pins is an error at startup', () {
      expect(
        () => TrustPolicy.parse(trust: 'pin', pins: ''),
        throwsA(isA<TrustConfigError>()),
      );
      expect(
        () => TrustPolicy.parse(trust: 'pin'),
        throwsA(isA<TrustConfigError>()),
      );
    });

    test('trust "link" with no embedded pins trusts the link pin', () {
      final policy = TrustPolicy.parse(trust: 'link', pins: '');

      expect(policy.pinsFor(link), {link});
    });

    test(
      'trust "link" with no embedded pins and no usable link pin errors',
      () {
        final policy = TrustPolicy.parse(trust: 'link');

        for (final linkPin in [null, '']) {
          expect(
            () => policy.pinsFor(linkPin),
            throwsA(isA<TrustConfigError>()),
            reason: '$linkPin',
          );
        }
      },
    );

    test('embedded pins win over the link pin even under trust "link"', () {
      final policy = TrustPolicy.parse(trust: 'link', pins: embedded);

      for (final linkPin in [null, '', link]) {
        expect(policy.pinsFor(linkPin), {embedded}, reason: '$linkPin');
      }
    });

    test('a missing trust value acts as "pin" with embedded pins', () {
      expect(TrustPolicy.parse(pins: embedded).pinsFor(link), {embedded});
    });

    test('a missing trust value acts as "link" without embedded pins', () {
      final policy = TrustPolicy.parse();

      expect(policy.pinsFor(link), {link});
      expect(() => policy.pinsFor(null), throwsA(isA<TrustConfigError>()));
    });

    test('an empty trust value acts like a missing one', () {
      expect(TrustPolicy.parse(trust: '', pins: embedded).pinsFor(null), {
        embedded,
      });
      expect(TrustPolicy.parse(trust: '').pinsFor(link), {link});
    });

    test('a typo in trust is an error at startup, never link trust', () {
      for (final bad in ['PIN', 'Link', 'pinn', 'none', 'disabled']) {
        expect(
          () => TrustPolicy.parse(trust: bad),
          throwsA(isA<TrustConfigError>()),
          reason: bad,
        );
      }
    });

    test('an unknown trust value is ignored once pins are embedded', () {
      expect(
        TrustPolicy.parse(trust: 'everything', pins: embedded).pinsFor(null),
        {embedded},
      );
    });

    test('splits pins on commas and drops blanks and spaces', () {
      final policy = TrustPolicy.parse(pins: ' $embedded , ,$other,');

      expect(policy.pinsFor(null), {embedded, other});
    });

    test('without build defines it trusts the link pin', () {
      final policy = TrustPolicy.fromEnvironment();

      expect(policy.pinsFor(link), {link});
    });
  });
}
