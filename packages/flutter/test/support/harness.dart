import 'dart:async';

import 'package:appduct/src/core/core.dart';

const startMs = 1700000000000;
const sessionId = 'XzAERP54_Goh74hZ';
const device = DeviceFields(
  manufacturer: 'Google',
  model: 'Pixel 9',
  os: 'Android 16',
);

ConnectInput connectInput({String? pin, int? expiresAt}) => ConnectInput(
  ip: '192.168.1.10',
  port: 8443,
  sessionId: sessionId,
  token: 'claim-token',
  expiresAt: expiresAt ?? startMs ~/ 1000 + 60,
  pin: pin,
);

Map<String, Object?> ack({
  bool eventRegistry = false,
  int graceS = 600,
  String resumeToken = 'resume-1',
  num keepaliveIntervalS = 15,
  String? session,
}) => {
  'type': 'session_ack',
  'session_id': session ?? sessionId,
  'status': 'ok',
  'alias': 'pixel',
  'resume_token': resumeToken,
  'keepalive_interval_s': keepaliveIntervalS,
  'grace_s': graceS,
  if (eventRegistry) 'event_registry': true,
};

/// Lets pending futures and socket close notifications run.
Future<void> settle() => Future<void>.delayed(Duration.zero);

/// A core over the memory fakes, with everything it emitted recorded.
class Harness {
  Harness({
    MemorySessionStore? store,
    ManualClock? clock,
    MemoryTransport? transport,
  }) : store = store ?? MemorySessionStore(),
       clock = clock ?? ManualClock(startMs),
       transport = transport ?? MemoryTransport() {
    core = createDartCore(
      DartCorePorts(
        transport: this.transport,
        sessionStore: this.store,
        clock: this.clock,
        random: const FixedRandom(0.5),
        device: device,
      ),
    );
    core.stateChanges.listen(states.add);
    core.sessionChanges.listen(sessions.add);
    core.errors.listen(errors.add);
    core.toolCalls.listen(toolCalls.add);
    core.toolCancels.listen(toolCancels.add);
  }

  final MemorySessionStore store;
  final ManualClock clock;
  final MemoryTransport transport;
  late final AppductCore core;

  final states = <StateChangeEvent>[];
  final sessions = <SessionChangeEvent>[];
  final errors = <ErrorEvent>[];
  final toolCalls = <ToolCallEvent>[];
  final toolCancels = <ToolCancelEvent>[];

  MemorySocket get last => transport.sockets.last;

  /// A new core over the same transport, store and clock, as after a hot restart.
  Harness restart() =>
      Harness(store: store, clock: clock, transport: transport);

  /// Claims a session end to end and returns the socket.
  Future<MemorySocket> claim({
    bool eventRegistry = false,
    int graceS = 600,
    ConnectInput? input,
  }) async {
    final done = core.connect(input ?? connectInput());
    final socket = last..open();
    socket.receive(ack(eventRegistry: eventRegistry, graceS: graceS));
    await done;
    return socket;
  }

  /// Frames of [type] the core sent on [socket].
  List<Map<String, Object?>> sentOf(MemorySocket socket, String type) => [
    for (final frame in socket.frames())
      if (frame['type'] == type) frame,
  ];
}
