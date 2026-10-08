/// Opt-in validation of tool arguments against the tool's JSON Schema.
///
/// ```dart
/// Appduct.instance.registerTool(
///   'add',
///   description: 'Adds two numbers.',
///   inputSchema: schema,
///   handler: validated(schema, (args, context) => (args['a'] as num) + (args['b'] as num)),
/// );
/// ```
library;

import 'package:json_schema_builder/json_schema_builder.dart';

import 'src/core/app_core.dart' show ToolFailure;
import 'src/flutter/appduct.dart' show AppductToolHandler;
import 'src/flutter/enabled.dart';

/// Wraps [handler] so arguments that do not match [inputSchema] answer
/// `tool_input_validation_error` without reaching it.
AppductToolHandler validated(
  Map<String, Object?> inputSchema,
  AppductToolHandler handler,
) {
  if (!appductEnabled) return handler;
  final schema = Schema.fromMap(inputSchema);
  return (args, context) {
    final errors = schema.validateSync(args);
    if (errors.isNotEmpty) {
      throw ToolFailure(
        'tool_input_validation_error',
        errors.map((e) => e.toErrorString()).join('; '),
      );
    }
    return handler(args, context);
  };
}
