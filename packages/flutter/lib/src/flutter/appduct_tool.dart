import 'package:flutter/widgets.dart';

import 'appduct.dart';

/// Registers a tool while it is mounted. A rebuild or hot reload registers nothing again; the
/// handler of the latest build serves the next call.
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
  late final void Function() _unregister;

  @override
  void initState() {
    super.initState();
    _unregister = Appduct.instance.registerTool(
      widget.name,
      description: widget.description,
      inputSchema: widget.inputSchema,
      timeout: widget.timeout,
      group: widget.group,
      handler: (args, context) => widget.handler(args, context),
    );
  }

  @override
  void dispose() {
    _unregister();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
