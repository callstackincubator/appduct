import 'dart:io';

import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/io/io.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';

void main() {
  late Directory runtime;
  setUp(() {
    debugDefaultTargetPlatformOverride = TargetPlatform.linux;
    runtime = Directory.systemTemp.createTempSync('appduct-lease-');
    if (!Platform.isWindows) Process.runSync('chmod', ['700', runtime.path]);
  });
  tearDown(() {
    debugDefaultTargetPlatformOverride = null;
    runtime.deleteSync(recursive: true);
  });

  FileSessionStore store(int pid) => FileSessionStore(
    appName: 'shop',
    environment: {'XDG_RUNTIME_DIR': runtime.path},
    isWindows: false,
    pid: pid,
  );

  Future<BindingHarness> earlierRun() async {
    final first = BindingHarness(leaseStore: store(1));
    await first.start();
    final done = first.appduct.connect(appductLink());
    await flush();
    await first.acceptLast();
    await done;
    return first;
  }

  group('with a lease file', () {
    test('a lease from an earlier run does not drop APPDUCT_LINK', () async {
      await earlierRun();

      final next = BindingHarness(
        leaseStore: store(2),
        environment: {'APPDUCT_LINK': appductLink(session: 'session-2')},
      );
      await next.start();

      expect(next.appduct.state.value, ClientState.connecting);
    });

    test('a hot restart in the same process resumes the lease', () async {
      final first = await earlierRun();

      final restarted = BindingHarness(
        leaseStore: store(1),
        transport: first.transport,
        clock: first.clock,
        environment: {'APPDUCT_LINK': appductLink()},
      );
      await restarted.start();

      expect(restarted.appduct.state.value, ClientState.reconnecting);
    });
  });
}
