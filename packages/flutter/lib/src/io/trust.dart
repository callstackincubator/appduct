/// A trust setting that cannot be honoured: an unknown `APPDUCT_TRUST`, `trust` "pin" with no pins
/// to pin to, or `trust` "link" with a link that carries no pin.
class TrustConfigError implements Exception {
  const TrustConfigError(this.message);

  final String message;

  @override
  String toString() => 'TrustConfigError: $message';
}

const _definedTrust = String.fromEnvironment('APPDUCT_TRUST');
const _definedPins = String.fromEnvironment('APPDUCT_PINS');

/// Which SPKI pins a connection may match, resolved the way the Swift and Kotlin cores do
/// (`resolveTrustedPins`): pins embedded at build time win and the link's pin is then ignored, so
/// configuration can only narrow trust. With none embedded, `trust` "link" (the default) trusts
/// the link's own pin for that session. A `trust` value other than "pin" or "link" is an error,
/// never a quiet fall back to link trust.
class TrustPolicy {
  const TrustPolicy._(this._embedded);

  /// [trust] is `APPDUCT_TRUST`; [pins] is `APPDUCT_PINS`, comma-separated `sha256/...` values.
  /// Throws [TrustConfigError] for an unknown [trust] and for "pin" without [pins].
  factory TrustPolicy.parse({String? trust, String? pins}) {
    final embedded = {
      for (final pin in (pins ?? '').split(','))
        if (pin.trim().isNotEmpty) pin.trim(),
    };
    if (embedded.isNotEmpty) return TrustPolicy._(embedded);

    switch (trust) {
      case null || '' || 'link':
        return const TrustPolicy._({});
      case 'pin':
        throw const TrustConfigError(
          'APPDUCT_TRUST=pin needs APPDUCT_PINS to name at least one sha256/... pin.',
        );
      default:
        throw TrustConfigError(
          'APPDUCT_TRUST must be "pin" or "link", got "$trust".',
        );
    }
  }

  /// From the `--dart-define` values `APPDUCT_TRUST` and `APPDUCT_PINS`.
  factory TrustPolicy.fromEnvironment() =>
      TrustPolicy.parse(trust: _definedTrust, pins: _definedPins);

  final Set<String> _embedded;

  /// The pins a connection for a link carrying [linkPin] may match. Throws [TrustConfigError] when
  /// there are no embedded pins and the link has none.
  Set<String> pinsFor(String? linkPin) {
    if (_embedded.isNotEmpty) return _embedded;
    if (linkPin == null || linkPin.isEmpty) {
      throw const TrustConfigError(
        'This build trusts the link\'s pin, and the link carries none.',
      );
    }
    return {linkPin};
  }
}
