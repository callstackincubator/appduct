import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

const _allowedDartLibraries = {
  'dart:async',
  'dart:convert',
  'dart:typed_data',
  'dart:math',
};

final _directive = RegExp(
  r'''^\s*(?:import|export|part)\s+(?:of\s+)?[^;]*;''',
  multiLine: true,
);
final _quotedUri = RegExp(r'''['"]([^'"]+)['"]''');

/// The directives in [source] that the pure core may not have: anything but the four `dart:`
/// libraries or a relative path that stays inside the core directory.
List<String> forbiddenImports(String source) {
  return [
    for (final directive in _directive.allMatches(source))
      for (final uri in _quotedUri.allMatches(directive.group(0)!))
        if (!_isAllowed(uri.group(1)!)) uri.group(1)!,
  ];
}

bool _isAllowed(String uri) {
  if (uri.startsWith('dart:')) return _allowedDartLibraries.contains(uri);
  if (uri.contains(':')) return false;
  return !Uri(path: uri).pathSegments.contains('..');
}

void main() {
  group('forbiddenImports', () {
    test('flags dart:io', () {
      expect(forbiddenImports("import 'dart:io';"), ['dart:io']);
    });

    test('flags package:flutter and third-party packages', () {
      expect(
        forbiddenImports(
          "import 'package:flutter/foundation.dart';\nimport 'package:http/http.dart';",
        ),
        ['package:flutter/foundation.dart', 'package:http/http.dart'],
      );
    });

    test('flags an export of a forbidden library', () {
      expect(forbiddenImports("export 'dart:ui';"), ['dart:ui']);
    });

    test('flags a relative path that leaves the core directory', () {
      expect(forbiddenImports("import '../io/socket.dart';"), [
        '../io/socket.dart',
      ]);
    });

    test('flags every uri of a conditional import', () {
      expect(
        forbiddenImports("import 'stub.dart' if (dart.library.io) 'dart:io';"),
        ['dart:io'],
      );
    });

    test('accepts the four allowed dart libraries and sibling files', () {
      const source = '''
import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:math';
import 'messages.dart';
export 'bootstrap.dart' show Bootstrap;
''';

      expect(forbiddenImports(source), isEmpty);
    });
  });

  test(
    'no file under lib/src/core imports anything outside the allowed libraries',
    () {
      final files = Directory('lib/src/core')
          .listSync(recursive: true)
          .whereType<File>()
          .where((file) => file.path.endsWith('.dart'))
          .toList();

      expect(files, isNotEmpty);
      for (final file in files) {
        expect(
          forbiddenImports(file.readAsStringSync()),
          isEmpty,
          reason: file.path,
        );
      }
    },
  );
}
