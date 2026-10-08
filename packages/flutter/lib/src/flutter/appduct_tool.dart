import 'package:flutter/widgets.dart';

import 'appduct.dart';

/// Registers a tool while it is mounted. A rebuild or hot reload registers again only when the
/// name, description, schema, timeout or group changed; the handler of the latest build serves
/// the next call.
class AppductTool extends StatefulWidget {
  const AppductTool({
    super.key,
    required this.name,
    required this.description,
    required this.handler,
    required this.child,
    this.inputSchema,
    this.timeout,
    this.group,
  });

  final String name;
  final String description;
  final AppductToolHandler handler;
  final Widget child;
  final Map<String, Object?>? inputSchema;
  final Duration? timeout;
  final String? group;

  @override
  State<AppductTool> createState() => _AppductToolState();
}

class _AppductToolState extends State<AppductTool> {
  late void Function() _unregister;

  @override
  void initState() {
    super.initState();
    _unregister = _register();
  }

  void Function() _register() => Appduct.instance.registerTool(
    widget.name,
    description: widget.description,
    inputSchema: widget.inputSchema,
    timeout: widget.timeout,
    group: widget.group,
    handler: (args, context) => widget.handler(args, context),
  );

  @override
  void didUpdateWidget(AppductTool oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.name == widget.name &&
        oldWidget.description == widget.description &&
        oldWidget.timeout == widget.timeout &&
        oldWidget.group == widget.group &&
        _deepEquals(oldWidget.inputSchema, widget.inputSchema)) {
      return;
    }
    _unregister();
    _unregister = _register();
  }

  @override
  void dispose() {
    _unregister();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

bool _deepEquals(Object? a, Object? b) {
  if (a is Map && b is Map) {
    return a.length == b.length &&
        a.keys.every((k) => b.containsKey(k) && _deepEquals(a[k], b[k]));
  }
  if (a is List && b is List) {
    return a.length == b.length &&
        Iterable<int>.generate(a.length).every((i) => _deepEquals(a[i], b[i]));
  }
  return a == b;
}
