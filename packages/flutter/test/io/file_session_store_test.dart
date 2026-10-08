import 'dart:io';

import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory dir;

  setUp(() => dir = Directory.systemTemp.createTempSync('appduct-store-'));
  tearDown(() => dir.deleteSync(recursive: true));

  FileSessionStore store([String app = 'shop']) =>
      FileSessionStore(appName: app, directory: dir);

  group('FileSessionStore', () {
    test('reads nothing before anything is written', () {
      expect(store().read(), isNull);
    });

    test('round-trips a lease', () {
      store().write('{"a":1}');

      expect(store().read(), '{"a":1}');
    });

    test('a new store instance reads what an earlier one wrote', () {
      final first = store()..write('lease-1');
      final second = store();

      expect(second.read(), 'lease-1');
      second.write('lease-2');
      expect(first.read(), 'lease-2');
    });

    test('clear forgets the lease, and clearing twice is fine', () {
      final s = store()..write('lease');

      s.clear();
      s.clear();

      expect(store().read(), isNull);
    });

    test('keeps one lease per app', () {
      store('shop').write('shop-lease');
      store('chat').write('chat-lease');

      expect(store('shop').read(), 'shop-lease');
      expect(store('chat').read(), 'chat-lease');
    });

    test('puts the lease in the system temp directory by default', () {
      final s = FileSessionStore(appName: 'appduct-default-dir-test')
        ..write('x');
      addTearDown(s.clear);

      expect(
        Directory.systemTemp.listSync().any(
          (e) => e.path.contains('appduct-default-dir-test'),
        ),
        isTrue,
      );
    });

    test('cannot be read by other users on a shared machine', () {
      store().write('secret');

      final file = dir.listSync().whereType<File>().single;
      if (!Platform.isWindows) {
        expect(file.statSync().mode & 0x3f, 0, reason: 'group/other bits');
      }
    });
  });
}
