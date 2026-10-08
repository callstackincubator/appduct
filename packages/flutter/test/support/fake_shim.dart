import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const shimChannel = MethodChannel('dev.appduct/shim');

/// Plays the native side of `dev.appduct/shim` on Flutter's channel fake.
class FakeShim {
  FakeShim({this.owner = true, this.links = const [], this.lease});

  bool owner;
  List<String> links;

  /// What native memory holds; survives a hot restart, which is a new Dart binding over this.
  String? lease;

  /// Method names Dart called, in order.
  final List<String> calls = [];

  int get activations => calls.where((c) => c == 'activate').length;

  void install() {
    TestWidgetsFlutterBinding.ensureInitialized();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(shimChannel, (call) async {
          calls.add(call.method);
          switch (call.method) {
            case 'activate':
              return {
                'owner': owner,
                'links': links,
                'lease': lease,
                'device': {
                  'manufacturer': 'Google',
                  'model': 'Pixel 9',
                  'os': 'Android 16',
                },
              };
            case 'writeLease':
              lease = call.arguments as String;
              return null;
            case 'clearLease':
              lease = null;
              return null;
          }
          throw MissingPluginException();
        });
  }

  /// Native hands Dart a link, as when the app is opened from a link while running.
  Future<void> pushLink(String link) async {
    final message = shimChannel.codec.encodeMethodCall(
      MethodCall('link', link),
    );
    await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .handlePlatformMessage(shimChannel.name, message, (_) {});
  }
}
