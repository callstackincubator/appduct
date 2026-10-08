import 'dart:convert';
import 'dart:io';

final _bin = File('../appduct/bin.js').absolute.path;
final _built = File('../appduct/dist/bin.js').existsSync();

/// Skipped on a developer machine that has not built the daemon; in CI a missing build fails.
final Object daemonSkip = _built || Platform.environment.containsKey('CI')
    ? false
    : 'run `pnpm build` at the repo root to build the daemon first';

/// A real daemon from packages/appduct's built CLI, in its own state directory. It needs
/// `pnpm build` first and runs in the Flutter CI job after that step.
class RealDaemon {
  RealDaemon() : stateDir = Directory.systemTemp.createTempSync('appduct-d-') {
    // The link must point at an address the app can reach, so the daemon advertises loopback.
    File('${stateDir.path}/config.json').writeAsStringSync(
      jsonEncode({'wssPort': 0, 'advertisedIp': '127.0.0.1'}),
    );
  }

  final Directory stateDir;

  /// The CLI's `--json` stdout: one JSON document, or NDJSON for streaming commands.
  Future<String> cli(List<String> args) async {
    final result = await Process.run(
      'node',
      [_bin, ...args, '--json'],
      environment: {'APPDUCT_STATE_DIR': stateDir.path},
    );
    return result.stdout as String;
  }

  /// A fresh bootstrap link, which starts the daemon if it is not running.
  Future<String> mintLink() async {
    final minted = await cli(['sessions', 'link', '--scheme', 'appduct-e2e']);
    return ((jsonDecode(minted) as Map)['data']! as Map)['deepLink']! as String;
  }

  Future<void> stop() async {
    await Process.run(
      'node',
      [_bin, 'daemon', 'stop'],
      environment: {'APPDUCT_STATE_DIR': stateDir.path},
    );
    stateDir.deleteSync(recursive: true);
  }
}
