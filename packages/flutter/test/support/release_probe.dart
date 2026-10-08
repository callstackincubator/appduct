// Compiled by release_strip_test.dart with `dart compile exe`, so it can import only pure Dart.
import 'package:appduct/src/flutter/enabled.dart';

void main() {
  if (appductEnabled) {
    // ignore: avoid_print
    print(appductDartCoreMarker);
  }
}
