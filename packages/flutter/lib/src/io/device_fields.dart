import 'dart:io';

import '../core/ports.dart';

/// Device fields for a platform without the native shim: the host's name as the model and its
/// operating system and version.
DeviceFields ioDeviceFields() {
  final host = Platform.localHostname;
  return DeviceFields(
    manufacturer: 'Dart',
    model: host.isEmpty ? 'unknown' : host,
    os: '${Platform.operatingSystem} ${Platform.operatingSystemVersion}'.trim(),
  );
}
