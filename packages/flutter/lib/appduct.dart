/// Call functions inside a running Flutter app from a terminal, a test runner or an agent.
library;

export 'src/core/app_core.dart' show ClientState, ToolFailure, AppductException;
export 'src/flutter/appduct.dart'
    show Appduct, AppductState, AppductToolHandler, ToolCallContext;
export 'src/flutter/appduct_tool.dart' show AppductTool;
