import 'package:appduct/src/flutter/composition.dart';
import 'package:flutter_test/flutter_test.dart';

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
}
