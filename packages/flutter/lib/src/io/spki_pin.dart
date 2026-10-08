import 'dart:convert';
import 'dart:typed_data';

import 'sha256.dart';

/// One DER element: where its content starts and where the whole element ends.
typedef _Tlv = ({int contentStart, int end});

/// Reads the element at [offset], or null when it does not fit in [d]. Handles short and long
/// form lengths; an indefinite length (0x80) or one wider than 4 bytes is not valid DER here.
_Tlv? _readTlv(Uint8List d, int offset) {
  if (offset < 0 || offset + 2 > d.length) return null;
  var i = offset + 1;
  var length = d[i++];
  if (length & 0x80 != 0) {
    final count = length & 0x7f;
    if (count == 0 || count > 4 || i + count > d.length) return null;
    length = 0;
    for (var k = 0; k < count; k++) {
      length = (length << 8) | d[i++];
    }
  }
  final end = i + length;
  return end > d.length ? null : (contentStart: i, end: end);
}

/// The `sha256/<base64>` pin of the certificate's public key: the SHA-256 of the DER
/// `SubjectPublicKeyInfo` inside [der], the same value `appduct keygen` prints. Returns null when
/// [der] is not a certificate this walk can read; it never throws.
///
/// Walks Certificate, then TBSCertificate, then past the optional `[0]` version and the serial,
/// signature, issuer, validity and subject fields to the next element, the SPKI.
String? spkiPin(Uint8List der) {
  final certificate = _readTlv(der, 0);
  if (certificate == null || der[0] != 0x30) return null;
  final tbs = _readTlv(der, certificate.contentStart);
  if (tbs == null || der[certificate.contentStart] != 0x30) return null;

  var p = tbs.contentStart;
  if (p >= der.length) return null;
  if (der[p] == 0xa0) {
    final version = _readTlv(der, p);
    if (version == null) return null;
    p = version.end;
  }
  for (var skip = 0; skip < 5; skip++) {
    final field = _readTlv(der, p);
    if (field == null) return null;
    p = field.end;
  }
  final spki = _readTlv(der, p);
  if (spki == null || der[p] != 0x30) return null;

  return 'sha256/${base64.encode(sha256(der.sublist(p, spki.end)))}';
}
