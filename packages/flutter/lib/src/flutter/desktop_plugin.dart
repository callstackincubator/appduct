/// Registered by Flutter on Windows and Linux, which have no native shim. It exists so the
/// platforms are declared in `pubspec.yaml` and pub.dev lists the package for them; the Dart
/// binding keeps its lease in a file there instead.
class AppductDesktopPlugin {
  static void registerWith() {}
}
