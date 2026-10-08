import 'dart:convert';
import 'dart:io';

/// Reads a conformance vector table straight from `packages/native/fixtures`, the same files the
/// TypeScript, Swift and Kotlin suites load. `flutter test` runs with the package root as cwd.
Object? loadFixture(String name) {
  final file = File('../native/fixtures/$name');
  return jsonDecode(file.readAsStringSync());
}

List<Map<String, Object?>> loadVectors(String name) {
  return (loadFixture(name)! as List).cast<Map<String, Object?>>();
}
