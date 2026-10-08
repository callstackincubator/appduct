import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('no file under lib/src/io imports Flutter', () {
    final files = Directory('lib/src/io')
        .listSync(recursive: true)
        .whereType<File>()
        .where((file) => file.path.endsWith('.dart'))
        .toList();

    expect(files, isNotEmpty);
    for (final file in files) {
      expect(
        file.readAsStringSync(),
        isNot(contains('package:flutter')),
        reason: file.path,
      );
    }
  });
}
