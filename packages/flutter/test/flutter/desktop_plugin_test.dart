import 'package:appduct/src/core/core.dart';
import 'package:appduct/src/flutter/desktop_plugin.dart';
import 'package:appduct/src/flutter/shim.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Windows and Linux have no native shim; the plugin class exists so pub.dev lists them.
  test('registering the desktop plugin needs no native code', () {
    expect(AppductDesktopPlugin.registerWith, returnsNormally);
  });

  test('a desktop app with no shim still owns Appduct with no lease', () async {
    AppductDesktopPlugin.registerWith();
    final activation = await Shim(
      fallbackDevice: const DeviceFields(
        manufacturer: 'Dell',
        model: 'XPS',
        os: 'linux',
      ),
    ).activate();
    expect(activation.owner, isTrue);
    expect(activation.lease, isNull);
    expect(activation.device.model, 'XPS');
  });
}
