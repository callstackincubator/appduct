import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _marker = 'appduct-dart-core/';

/// Compiles the probe to a native AOT executable, the same compiler Flutter release builds use,
/// and returns the bytes of the result.
Future<List<int>> _compile(
  Directory dir,
  String name,
  List<String> args,
) async {
  final out = '${dir.path}/$name';
  final result = await Process.run('dart', [
    'compile',
    'exe',
    ...args,
    '-o',
    out,
    'test/support/release_probe.dart',
  ]);
  expect(result.exitCode, 0, reason: '${result.stdout}${result.stderr}');
  return File(out).readAsBytes();
}

bool _contains(List<int> haystack, String needle) {
  final n = needle.codeUnits;
  for (var i = 0; i <= haystack.length - n.length; i++) {
    var j = 0;
    while (j < n.length && haystack[i + j] == n[j]) {
      j++;
    }
    if (j == n.length) return true;
  }
  return false;
}

void main() {
  late Directory dir;
  setUpAll(() => dir = Directory.systemTemp.createTempSync('appduct-strip'));
  tearDownAll(() => dir.deleteSync(recursive: true));

  test(
    'the marker is absent from an AOT build with APPDUCT_ENABLED=false',
    () async {
      final bytes = await _compile(dir, 'off', ['-DAPPDUCT_ENABLED=false']);

      expect(_contains(bytes, _marker), isFalse);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test(
    'the marker is present in an AOT build with APPDUCT_ENABLED=true',
    () async {
      final bytes = await _compile(dir, 'on', ['-DAPPDUCT_ENABLED=true']);

      expect(_contains(bytes, _marker), isTrue);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );

  test('the marker survives --obfuscate when APPDUCT_ENABLED=true', () async {
    final bytes = await _compile(dir, 'obfuscated', [
      '-DAPPDUCT_ENABLED=true',
      '--extra-gen-snapshot-options=--obfuscate',
    ]);

    expect(_contains(bytes, _marker), isTrue);
  }, timeout: const Timeout(Duration(minutes: 3)));

  test(
    'the marker is absent from an obfuscated build with APPDUCT_ENABLED=false',
    () async {
      final bytes = await _compile(dir, 'obfuscated-off', [
        '-DAPPDUCT_ENABLED=false',
        '--extra-gen-snapshot-options=--obfuscate',
      ]);

      expect(_contains(bytes, _marker), isFalse);
    },
    timeout: const Timeout(Duration(minutes: 3)),
  );
}
