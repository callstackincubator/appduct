import 'package:appduct/src/io/io.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('ioDeviceFields names the host operating system', () {
    final fields = ioDeviceFields();

    expect(fields.os, isNotEmpty);
    expect(fields.manufacturer, isNotEmpty);
    expect(fields.model, isNotEmpty);
  });
}
