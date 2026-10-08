import 'package:flutter/services.dart';

import '../core/core.dart';

/// What `activate` answers: whether this isolate owns Appduct, the links native saw before Dart
/// could listen, the lease held in native memory, and the device names.
class ShimActivation {
  const ShimActivation({
    required this.owner,
    required this.links,
    required this.lease,
    required this.device,
  });

  final bool owner;
  final List<String> links;
  final String? lease;
  final DeviceFields device;
}

/// The Dart side of `MethodChannel('dev.appduct/shim')`. On a platform with no shim (Windows,
/// Linux) every call behaves as an owner with nothing pending and no lease kept.
class Shim {
  Shim({required DeviceFields fallbackDevice})
    : _fallbackDevice = fallbackDevice;

  static const _channel = MethodChannel('dev.appduct/shim');

  final DeviceFields _fallbackDevice;

  Future<ShimActivation> activate() async {
    try {
      final reply = await _channel.invokeMapMethod<String, Object?>('activate');
      final device = (reply?['device'] as Map?)?.cast<String, Object?>();
      return ShimActivation(
        owner: reply?['owner'] == true,
        links: [...?(reply?['links'] as List?)?.cast<String>()],
        lease: reply?['lease'] as String?,
        device: device == null
            ? _fallbackDevice
            : DeviceFields(
                manufacturer: device['manufacturer'] as String? ?? 'Unknown',
                model: device['model'] as String? ?? 'Unknown',
                os: device['os'] as String? ?? 'Unknown',
              ),
      );
    } on MissingPluginException {
      return ShimActivation(
        owner: true,
        links: const [],
        lease: null,
        device: _fallbackDevice,
      );
    }
  }

  Future<void> writeLease(String lease) => _fireAndForget('writeLease', lease);

  Future<void> clearLease() => _fireAndForget('clearLease');

  /// Calls [onLink] with every link native receives while the app runs.
  void listenForLinks(void Function(String link) onLink) {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'link' && call.arguments is String) {
        onLink(call.arguments as String);
      }
    });
  }

  void stopListening() => _channel.setMethodCallHandler(null);

  Future<void> _fireAndForget(String method, [Object? argument]) async {
    try {
      await _channel.invokeMethod<void>(method, argument);
    } on MissingPluginException {
      // No shim on this platform, so there is no lease to keep.
    } on PlatformException {
      // A lease that cannot be kept only costs the resume after a hot restart.
    }
  }
}

/// The resume lease, kept in native memory through the shim so it outlives a hot restart.
class ShimSessionStore implements SessionStore {
  ShimSessionStore(this._shim);

  final Shim _shim;
  String? _lease;

  /// The lease `activate` returned.
  void load(String? lease) => _lease = lease;

  @override
  String? read() => _lease;

  @override
  void write(String value) {
    _lease = value;
    _shim.writeLease(value);
  }

  @override
  void clear() {
    _lease = null;
    _shim.clearLease();
  }
}
