// The binding over its real ports against a real daemon. Needs `pnpm build` first.
import 'dart:io';

import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/flutter/appduct.dart';
import 'package:appduct/src/flutter/composition.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart' show flush;
import '../support/daemon.dart';
import '../support/fake_shim.dart';

void main() {
  late RealDaemon daemon;
  late Directory leaseDir;

  setUp(() {
    daemon = RealDaemon();
    leaseDir = Directory.systemTemp.createTempSync('appduct-lease-');
    FakeShim().install();
  });

  tearDown(() async {
    await Appduct.instance.disconnect();
    await daemon.stop();
    leaseDir.deleteSync(recursive: true);
  });

  test(
    'connect(link) claims against a real daemon and serves a tool call',
    () async {
      final appduct = installAppduct(
        productionPorts(
          environment: {'XDG_RUNTIME_DIR': leaseDir.path},
          isWindows: false,
          isLinux: true,
        ),
      );
      appduct.registerTool(
        'add',
        description: 'Add two numbers.',
        inputSchema: {
          'type': 'object',
          'properties': {
            'a': {'type': 'number'},
            'b': {'type': 'number'},
          },
        },
        handler: (args, _) => {
          'sum': (args['a']! as num) + (args['b']! as num),
        },
      );
      await flush();

      await appduct
          .connect(await daemon.mintLink())
          .timeout(const Duration(seconds: 20));

      expect(appduct.state.value, ClientState.active);
      final out = await daemon.cli([
        'tools',
        'call',
        'add',
        '--input',
        '{"a":2,"b":3}',
      ]);
      expect(out, contains('"sum":5'));
      expect(
        leaseDir.listSync().map((e) => e.path),
        contains(endsWith('.lease')),
      );
    },
    skip: daemonSkip,
    timeout: const Timeout(Duration(seconds: 90)),
  );
}
