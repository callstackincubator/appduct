import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/flutter/appduct.dart';
import 'package:appduct/src/flutter/composition.dart';
import 'package:appduct/src/flutter/ports.dart';
import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/binding_harness.dart';
import '../support/fake_shim.dart';

void main() {
  test('keeps the private address check on unless the build turns it off', () {
    expect(productionPorts().allowPrivateLanOnly, isTrue);
  });

  test('keeps the lease in a file on Windows and Linux only', () {
    expect(
      productionPorts(isWindows: true, isLinux: false).leaseStore,
      isNotNull,
    );
    expect(
      productionPorts(isWindows: false, isLinux: true).leaseStore,
      isNotNull,
    );
    expect(
      productionPorts(isWindows: false, isLinux: false).leaseStore,
      isNull,
    );
  });

  test('a bad APPDUCT_TRUST fails the connect, not the app start', () async {
    FakeShim().install();
    final appduct = installAppduct(
      BindingPorts(
        transport: IoTransport.resolving(
          () => TrustPolicy.parse(trust: 'pinn'),
        ),
        clock: ManualClock(startMs),
        random: const FixedRandom(0.5),
        environment: const {},
        allowPrivateLanOnly: true,
        isRootIsolate: () => true,
        warn: (_) {},
      ),
    );
    await flush();

    await expectLater(
      appduct.connect(appductLink()),
      throwsA(
        isA<AppductException>().having(
          (e) => e.toString(),
          'message',
          contains('APPDUCT_TRUST'),
        ),
      ),
    );
  });
}
