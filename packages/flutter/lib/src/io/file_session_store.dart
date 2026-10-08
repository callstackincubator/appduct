import 'dart:io';

import '../core/ports.dart';

/// Keeps the resume lease in a file under the system temp directory, named after the app, for
/// platforms without the native shim (Windows and Linux). A hot restart finds it again; a crash
/// leaves a stale lease behind, which the daemon refuses at most once.
class FileSessionStore implements SessionStore {
  /// [directory] defaults to the system temp directory.
  FileSessionStore({required String appName, Directory? directory})
    : _file = File(
        '${(directory ?? Directory.systemTemp).path}'
        '${Platform.pathSeparator}appduct-${appName.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}.lease',
      );

  final File _file;

  @override
  String? read() => _file.existsSync() ? _file.readAsStringSync() : null;

  @override
  void write(String value) {
    if (!_file.existsSync()) {
      _file.createSync();
      // The lease holds a resume token; keep it from other users of a shared temp directory.
      if (!Platform.isWindows) Process.runSync('chmod', ['600', _file.path]);
    }
    _file.writeAsStringSync(value, flush: true);
  }

  @override
  void clear() {
    if (_file.existsSync()) _file.deleteSync();
  }
}
