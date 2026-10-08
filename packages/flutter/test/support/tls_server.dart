import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// A loopback `wss` server with a throwaway self-signed certificate that `openssl` mints into a
/// temp directory when the server starts. The key material never touches the repository.
///
/// The server echoes every text frame back as `echo:<frame>`, sends a binary frame when it gets
/// `binary`, and counts the HTTP requests that got past the TLS handshake.
class TlsServer {
  TlsServer._(this._server, this._dir, this.pin);

  final HttpServer _server;
  final Directory _dir;

  /// The `sha256/...` SPKI pin of the certificate, computed by `openssl`.
  final String pin;

  /// HTTP requests that reached the application, i.e. past the TLS handshake.
  int requests = 0;

  /// Text frames the server received, in order.
  final List<String> received = [];

  int get port => _server.port;

  static Future<TlsServer> start() async {
    final dir = Directory.systemTemp.createTempSync('appduct-tls-');
    final key = '${dir.path}/key.pem';
    final cert = '${dir.path}/cert.pem';
    _run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1', //
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=appduct-test',
    ]);
    final pubkey = _run('openssl', ['x509', '-in', cert, '-pubkey', '-noout']);
    final der = _run('openssl', [
      'pkey',
      '-pubin',
      '-outform',
      'der',
    ], stdin: pubkey);
    final digest = _run('openssl', ['dgst', '-sha256', '-binary'], stdin: der);
    final pin = 'sha256/${base64.encode(digest as List<int>)}';

    final context = SecurityContext()
      ..useCertificateChain(cert)
      ..usePrivateKey(key);
    final http = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      context,
    );
    final server = TlsServer._(http, dir, pin);
    http.listen(server._handle);
    return server;
  }

  void _handle(HttpRequest request) async {
    requests++;
    final socket = await WebSocketTransformer.upgrade(request);
    socket.listen((data) {
      if (data is String) {
        received.add(data);
        if (data == 'binary') {
          socket.add([1, 2, 3]);
        } else {
          socket.add('echo:$data');
        }
      }
    });
  }

  Future<void> stop() async {
    await _server.close(force: true);
    _dir.deleteSync(recursive: true);
  }
}

Object _run(String exe, List<String> args, {Object? stdin}) {
  final process = stdin == null
      ? Process.runSync(exe, args, stdoutEncoding: null)
      : _runWithStdin(exe, args, stdin as List<int>);
  if (process.exitCode != 0) {
    throw StateError('$exe failed: ${process.stderr}');
  }
  return process.stdout as Object;
}

ProcessResult _runWithStdin(String exe, List<String> args, List<int> stdin) {
  // Process.runSync has no stdin; go through the shell with a temp file.
  final file = File(
    '${Directory.systemTemp.path}/appduct-stdin-${stdin.hashCode}',
  );
  file.writeAsBytesSync(stdin);
  try {
    return Process.runSync('sh', [
      '-c',
      '"\$0" "\$@" < "${file.path}"',
      exe,
      ...args,
    ], stdoutEncoding: null);
  } finally {
    file.deleteSync();
  }
}
