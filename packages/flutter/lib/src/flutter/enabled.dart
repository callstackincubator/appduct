import 'package:flutter/foundation.dart';

/// Whether Appduct is compiled in. Every public entry point checks this constant, so a release
/// build keeps none of the binding.
const appductEnabled = bool.fromEnvironment(
  'APPDUCT_ENABLED',
  defaultValue: !kReleaseMode,
);
