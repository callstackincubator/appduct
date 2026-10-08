import 'dart:io';

import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory runtime;
  late Directory home;

  setUp(() {
    runtime = Directory.systemTemp.createTempSync('appduct-runtime-');
    home = Directory.systemTemp.createTempSync('appduct-home-');
    if (!Platform.isWindows) Process.runSync('chmod', ['700', runtime.path]);
  });
  tearDown(() {
    runtime.deleteSync(recursive: true);
    home.deleteSync(recursive: true);
  });

  FileSessionStore store([String app = 'shop']) => FileSessionStore(
    appName: app,
    environment: {'XDG_RUNTIME_DIR': runtime.path, 'HOME': home.path},
    isWindows: false,
  );

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

    test(
      'keeps the lease in the user runtime directory, not the shared temp',
      () {
        store('runtime-dir-test').write('x');

        expect(
          runtime.listSync().any((e) => e.path.contains('runtime-dir-test')),
          isTrue,
        );
        expect(
          Directory.systemTemp.listSync().whereType<File>().any(
            (e) => e.path.contains('runtime-dir-test'),
          ),
          isFalse,
        );
      },
    );

    test(
      'falls back to an existing owner-only ~/.appduct without a runtime dir',
      () {
        final dir = Directory('${home.path}/.appduct')..createSync();
        Process.runSync('chmod', ['700', dir.path]);
        final s = FileSessionStore(
          appName: 'shop',
          environment: {'HOME': home.path},
          isWindows: false,
        )..write('lease');

        expect(s.read(), 'lease');
        expect(dir.listSync().whereType<File>(), hasLength(1));
      },
      skip: Platform.isWindows,
    );

    test('writes no file into a ~/.appduct that others can read', () {
      final dir = Directory('${home.path}/.appduct')..createSync();
      Process.runSync('chmod', ['755', dir.path]);
      final s = FileSessionStore(
        appName: 'shop',
        environment: {'HOME': home.path},
        isWindows: false,
      )..write('lease');

      expect(dir.listSync(), isEmpty);
      expect(s.read(), 'lease');
    }, skip: Platform.isWindows);

    test('does not create ~/.appduct, which would be readable by others', () {
      FileSessionStore(
        appName: 'shop',
        environment: {'HOME': home.path},
        isWindows: false,
      ).write('lease');

      expect(Directory('${home.path}/.appduct').existsSync(), isFalse);
    });

    test('uses the local app data directory on Windows', () {
      final s = FileSessionStore(
        appName: 'shop',
        environment: {'LOCALAPPDATA': runtime.path, 'HOME': home.path},
        isWindows: true,
      )..write('lease');

      expect(s.read(), 'lease');
      expect(runtime.listSync(recursive: true).whereType<File>(), hasLength(1));
    });

    test(
      'keeps the lease in memory only when no per-user location is known',
      () {
        final s = FileSessionStore(
          appName: 'shop',
          environment: const {},
          isWindows: false,
        )..write('lease');

        expect(s.read(), 'lease');
        s.clear();
        expect(s.read(), isNull);
      },
    );

    test(
      'keeps no file and ignores a planted lease in a directory others can read',
      () {
        File('${runtime.path}/appduct-shop.lease').writeAsStringSync('planted');
        Process.runSync('chmod', ['755', runtime.path]);
        final s = store();

        expect(s.read(), isNull);
        s.write('mine');
        expect(s.read(), 'mine');
        expect(
          File('${runtime.path}/appduct-shop.lease').readAsStringSync(),
          'planted',
        );
        expect(store().read(), isNull);
      },
      skip: Platform.isWindows,
    );

    test('ignores a lease in a directory other users can write to', () {
      Process.runSync('chmod', ['777', runtime.path]);
      File('${runtime.path}/appduct-shop.lease').writeAsStringSync('planted');

      expect(store().read(), isNull);
    }, skip: Platform.isWindows);
  });
}
