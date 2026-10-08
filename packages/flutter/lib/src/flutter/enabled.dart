/// Whether Appduct is compiled in: on in debug and profile builds, off in release, and
/// `--dart-define=APPDUCT_ENABLED=true` or `=false` overrides either way. Every public entry point
/// checks this constant, so a release build keeps none of the binding.
///
/// `dart.vm.product` is what Flutter's `kReleaseMode` reads; using it directly keeps this file free
/// of Flutter imports so the compile-out can be proved with plain `dart compile exe`.
const appductEnabled = bool.fromEnvironment(
  'APPDUCT_ENABLED',
  defaultValue: !bool.fromEnvironment('dart.vm.product'),
);

/// Written once by [Appduct.ensureInitialized] behind [appductEnabled]. `appduct doctor` looks for
/// this string in `libapp.so` and `App.framework/App`; keep the prefix, and the version in step
/// with `pubspec.yaml`.
const appductDartCoreMarker = 'appduct-dart-core/0.0.1';
