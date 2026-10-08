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
      'falls back to a private directory under home without a runtime dir',
      () {
        final s = FileSessionStore(
          appName: 'shop',
          environment: {'HOME': home.path},
          isWindows: false,
        )..write('lease');

        expect(s.read(), 'lease');
        expect(Directory('${home.path}/.appduct').existsSync(), isTrue);
      },
    );

    test('uses the local app data directory on Windows', () {
      final s = FileSessionStore(
        appName: 'shop',
        environment: {'LOCALAPPDATA': runtime.path, 'HOME': home.path},
        isWindows: true,
      )..write('lease');

      expect(s.read(), 'lease');
      expect(runtime.listSync(recursive: true).whereType<File>(), hasLength(1));
    });

    test('keeps no lease when no per-user location is known', () {
      final s = FileSessionStore(
        appName: 'shop',
        environment: const {},
        isWindows: false,
      )..write('lease');

      expect(s.read(), isNull);
    });

    test('ignores a lease in a directory other users can write to', () {
      store().write('planted');
      Process.runSync('chmod', ['777', runtime.path]);

      expect(store().read(), isNull);
      store().write('overwritten');
      expect(
        File(runtime.listSync().single.path).readAsStringSync(),
        'planted',
      );
    }, skip: Platform.isWindows);
  });
}
