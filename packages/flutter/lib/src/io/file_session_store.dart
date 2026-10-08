import 'dart:io';

import '../core/ports.dart';

/// Keeps the resume lease in a file named after the app, for platforms without the native shim
/// (Windows and Linux). A hot restart finds it again; a crash leaves a stale lease behind, which
/// the daemon refuses at most once.
///
/// The lease is a trust input (it names the daemon and the pin a resume trusts), so it lives only
/// in a per-user directory that no other user can write to: `$XDG_RUNTIME_DIR`, else
/// `~/.appduct`, or `%LOCALAPPDATA%` on Windows. A directory that others can write to is
/// treated as holding no lease, and with no per-user location the lease is not kept.
class FileSessionStore implements SessionStore {
  /// [environment] and [isWindows] default to the real process.
  FileSessionStore({
    required String appName,
    Map<String, String>? environment,
    bool? isWindows,
  }) : _windows = isWindows ?? Platform.isWindows,
       _env = environment ?? Platform.environment,
       _fileName =
           'appduct-${appName.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}.lease';

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

  /// The lease file, or null when there is no per-user location or others can write to it.
  File? _file({required bool create}) {
    final base = _base();
    if (base == null) return null;
    final dir = Directory(base);
    if (create && !dir.existsSync()) dir.createSync(recursive: true);
    if (!dir.existsSync()) return null;
    // Group- or world-writable (0o022): another user could plant or swap the lease.
    if (!_windows && dir.statSync().mode & 18 != 0) return null;
    return File('$base${Platform.pathSeparator}$_fileName');
  }

  @override
  String? read() {
    final file = _file(create: false);
    return file != null && file.existsSync() ? file.readAsStringSync() : null;
  }

  @override
  void write(String value) =>
      _file(create: true)?.writeAsStringSync(value, flush: true);

  @override
  void clear() {
    final file = _file(create: false);
    if (file != null && file.existsSync()) file.deleteSync();
  }
}
