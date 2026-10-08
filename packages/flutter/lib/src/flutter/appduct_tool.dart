import 'package:flutter/widgets.dart';

import 'appduct.dart';

/// Registers a tool while it is mounted.
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
  @override
  Widget build(BuildContext context) => widget.child;
}
