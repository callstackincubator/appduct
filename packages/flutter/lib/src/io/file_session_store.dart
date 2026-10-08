import 'dart:io';
import 'dart:io' as io show pid;

import '../core/ports.dart';

/// Keeps the resume lease in a file named after the app, for platforms without the native shim
/// (Windows and Linux). A hot restart finds it again; a crash leaves a stale lease behind, which
/// the daemon refuses at most once.
///
/// The lease is a trust input (it names the daemon and the pin a resume trusts, and holds the
/// resume token), so a file is used only inside an existing directory that no other user can
/// read or write: `$XDG_RUNTIME_DIR` (0700 by spec), else an existing owner-only `~/.appduct`, or
/// `%LOCALAPPDATA%` on Windows. Dart cannot set a directory's mode without FFI or a subprocess, so
/// nothing is created. With no such directory the lease lives in memory only: a hot restart
/// starts without it, and a file planted by someone else is never read.
class FileSessionStore implements SessionStore {
  /// [environment], [isWindows] and [pid] default to the real process.
  FileSessionStore({
    required String appName,
    Map<String, String>? environment,
    bool? isWindows,
    int? pid,
  }) : _pid = pid ?? io.pid,
       _windows = isWindows ?? Platform.isWindows,
       _env = environment ?? Platform.environment,
       _fileName =
           'appduct-${appName.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}.lease';

  final int _pid;
  final bool _windows;
  final Map<String, String> _env;
  final String _fileName;

  String? _base() {
    if (_windows) return _env['LOCALAPPDATA'];
    final runtime = _env['XDG_RUNTIME_DIR'];
    if (runtime != null && runtime.isNotEmpty) return runtime;
    final home = _env['HOME'];
    return home == null || home.isEmpty ? null : '$home/.appduct';
  }

  /// The lease file, or null when there is no owner-only directory.
  File? _file() {
    final base = _base();
    if (base == null) return null;
    final dir = Directory(base);
    if (!dir.existsSync()) return null;
    // Any group or other permission bit (0o077): another user could read or replace the lease.
    if (!_windows && dir.statSync().mode & 63 != 0) return null;
    return File('$base${Platform.pathSeparator}$_fileName');
  }

  String? _memory;

  @override
  String? read() {
    final file = _file();
    if (file == null) return _memory;
    if (!file.existsSync()) return null;
    // "<pid>\n<lease>": a lease another process wrote is a stale one, as no file outlives a
    // process the way the shim's memory does.
    final text = file.readAsStringSync();
    final split = text.indexOf('\n');
    return split > 0 && text.substring(0, split) == '$_pid'
        ? text.substring(split + 1)
        : null;
  }

  @override
  void write(String value) {
    final file = _file();
    if (file == null) {
      _memory = value;
    } else {
      file.writeAsStringSync('$_pid\n$value', flush: true);
    }
  }

  @override
  void clear() {
    _memory = null;
    final file = _file();
    if (file != null && file.existsSync()) file.deleteSync();
  }
}
