import AppductCore
import Foundation

/// Registers the same tools `playground/app/(tabs)/index.tsx` (the Expo playground) registers --
/// same names, descriptions, and schemas -- so `appduct tools ls` reports an equivalent surface
/// regardless of which playground app answered the link. Implementations are simple in-memory
/// mirrors of the Expo versions, backed by `PlaygroundViewModel.shared` instead of React state.
enum PlaygroundTools {
  /// Called once from `AppductPlaygroundApp.init()`. `try!` is deliberate: every descriptor
  /// below is a compile-time-fixed literal, so a throw here can only mean a programmer error in
  /// this file itself (a bad name/description), which should crash a debug build loudly rather
  /// than silently register nothing.
  @MainActor
  static func registerAll() {
    let store = PlaygroundViewModel.shared

    try! Appduct.shared.register(
      name: "sum",
      description: "Adds two numbers. Counts as a call in call_count.",
      inputSchema: [
        "type": "object",
        "properties": [
          "a": ["type": "number"],
          "b": ["type": "number"],
        ],
        "required": ["a", "b"],
      ],
      outputSchema: [
        "type": "object",
        "properties": ["total": ["type": "number"]],
      ]
    ) { args in
      let a = (args["a"] as? NSNumber)?.doubleValue ?? 0
      let b = (args["b"] as? NSNumber)?.doubleValue ?? 0
      await store.bumpCallCount()
      return ["total": a + b]
    }

    try! Appduct.shared.register(
      name: "call_count",
      description: "Reports how many times the counted tools (sum, slow_task) have run. Read-only.",
      outputSchema: [
        "type": "object",
        "properties": ["count": ["type": "number"]],
      ],
      annotations: ToolAnnotations(readOnlyHint: true)
    ) { _ in
      ["count": await store.callCount]
    }

    try! Appduct.shared.register(
      name: "reset_counter",
      description: "Resets the call counter to zero. Destructive; a no-op when it is already zero.",
      outputSchema: [
        "type": "object",
        "properties": ["count": ["type": "number"]],
      ],
      annotations: ToolAnnotations(destructiveHint: true, idempotentHint: true)
    ) { _ in
      await store.resetCallCount()
      return ["count": 0]
    }

    try! Appduct.shared.register(
      name: "slow_task",
      description: "Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.",
      outputSchema: [
        "type": "object",
        "properties": ["done": ["type": "boolean"]],
      ],
      timeoutMs: 5_000
    ) { _, context in
      for (progress, message) in [(0.33, "warming up"), (0.66, "almost there"), (1.0, "done")] {
        try await Task.sleep(nanoseconds: 500_000_000)
        await context.reportProgress(progress: progress, message: message)
      }
      await store.bumpCallCount()
      return ["done": true]
    }

    try! Appduct.shared.register(
      name: "throwing_tool",
      description: "Always fails with tool_execution_error. Changes nothing.",
      annotations: ToolAnnotations(readOnlyHint: true)
    ) { _ in
      throw PlaygroundToolError.alwaysFails
    }
  }
}

struct PlaygroundToolError: Error, LocalizedError {
  static let alwaysFails = PlaygroundToolError()
  var errorDescription: String? { "throwing_tool always fails on purpose." }
}
