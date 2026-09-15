// Vendored into @cordierite/react-native at build time by scripts/sync-native-core.mjs -- see
// packages/native/README.md. (The RN bridge does not use this facade -- CordieriteTurboBridge.swift
// talks to CordieriteClient directly -- but the sync script copies the whole Real/ directory
// verbatim, so this file travels along for free and costs the RN pod nothing it doesn't already
// pay for CordieriteClient itself.)
#if CORDIERITE_ENABLED

import Foundation

/// The plain-app-facing entry point for the Cordierite native core (issue #48 phase 3,
/// `docs/tasks/18-ios-entry-points.md`): a facade over `CordieriteClient` for an app that wants
/// tools, deep-link handling, and connection state without touching `JSONValue`, `ToolDescriptor`'s
/// wire shape, or the underlying actor directly. Everything at this boundary speaks
/// `[String: Any]`/`Any`, converted to/from the core's `JSONValue` using the same rules
/// `JSONSerialization` uses (see `jsonValue(fromFoundation:)` below).
///
/// One instance is meant to live for the app process's lifetime; use `Cordierite.shared` rather than
/// constructing your own (the initializer is deliberately not public, so a second, independent
/// session-owning client can't accidentally be created).
public final class Cordierite: Sendable {
  /// First access constructs the underlying `CordieriteClient` and kicks off `restoreSession()` in
  /// the background -- recovering a still-valid process-memory resume lease (e.g. after a Metro-less
  /// native process is merely suspended and resumed, not relaunched) without the app having to
  /// remember to call it itself. A `static let` is Swift's own thread-safe, exactly-once
  /// lazy-initialization primitive, so "first access" above is well-defined even under concurrent
  /// callers.
  public static let shared = Cordierite()

  let client: CordieriteClient

  /// `internal`, not `private`: a plain app (a different module) can only ever reach this facade
  /// through `Cordierite.shared`, but `CordieriteCoreTests` (`@testable import CordieriteCore`)
  /// uses this initializer directly to wrap a scripted `FakeTransportSession`/`FakeClientTimers`
  /// pair instead of a real `CordieriteConnectionManager` -- see `CordieriteAPITests.swift`.
  init(client: CordieriteClient = CordieriteClient()) {
    self.client = client
    let capturedClient = client
    Task { _ = await capturedClient.restoreSession() }
  }

  // MARK: Tool registration

  /// Registers (or replaces, by name) a tool, converting `inputSchema`/`outputSchema` from plain
  /// `[String: Any]` JSON Schema objects into the core's wire representation. `handler` runs off the
  /// main actor -- an app whose handler touches UI must hop back with `await MainActor.run { ... }`
  /// (or mark the handler `@MainActor` itself, since `@Sendable` closures may still be actor-isolated).
  /// The returned `ToolRegistration.remove()` unregisters this tool; letting the value go out of
  /// scope does **not** unregister it -- call `remove()` explicitly.
  @discardableResult
  public func register(
    name: String,
    description: String,
    inputSchema: [String: Any]? = nil,
    outputSchema: [String: Any]? = nil,
    annotations: ToolAnnotations? = nil,
    timeoutMs: Int? = nil,
    handler: @escaping @Sendable ([String: Any], ToolCallContext) async throws -> Any?
  ) throws -> ToolRegistration {
    let descriptor = try makeToolDescriptor(
      name: name,
      description: description,
      inputSchema: inputSchema,
      outputSchema: outputSchema,
      annotations: annotations,
      timeoutMs: timeoutMs
    )

    let coreHandler: ToolHandler = { args, context in
      let foundationArgs = args.mapValues { $0.foundationValue }
      let result = try await handler(foundationArgs, context)
      return try Cordierite.jsonValue(fromToolResult: result)
    }

    try client.registerTool(descriptor, handler: coreHandler)

    let client = self.client
    return ToolRegistration { client.unregisterTool(name) }
  }

  /// Convenience overload for a handler that doesn't need `ToolCallContext` (progress reporting,
  /// cancellation reason).
  @discardableResult
  public func register(
    name: String,
    description: String,
    inputSchema: [String: Any]? = nil,
    outputSchema: [String: Any]? = nil,
    annotations: ToolAnnotations? = nil,
    timeoutMs: Int? = nil,
    handler: @escaping @Sendable ([String: Any]) async throws -> Any?
  ) throws -> ToolRegistration {
    try register(
      name: name,
      description: description,
      inputSchema: inputSchema,
      outputSchema: outputSchema,
      annotations: annotations,
      timeoutMs: timeoutMs,
      handler: { args, _ in try await handler(args) }
    )
  }

  // MARK: Deep links

  /// Feeds a deep link to the core. Returns `true` iff `url` carried a Cordierite bootstrap payload
  /// -- the actual parse/connect work happens asynchronously; failures surface through
  /// `addListener`'s `.error` case, exactly as `CordieriteClient.handleUrl` documents.
  public func handle(_ url: URL) -> Bool {
    client.handleUrl(url.absoluteString)
  }

  // MARK: Events

  /// Emits an app event (`postEvent`, PROTOCOL.md §7) while a session is active; throws otherwise
  /// (see `CordieriteClient.postEvent`). `payload`, if present, must be convertible by the same rules
  /// as a tool result.
  public func postEvent(_ name: String, payload: Any? = nil) async throws {
    let jsonPayload: JSONValue?
    if let payload {
      guard let converted = try? Cordierite.jsonValue(fromFoundation: payload) else {
        throw CordieriteJSONError("Cordierite event payload is not JSON-serializable.")
      }
      jsonPayload = converted
    } else {
      jsonPayload = nil
    }
    try await client.postEvent(name, payload: jsonPayload)
  }

  // MARK: State

  /// Synchronous snapshot of the connection state -- safe to read from any thread, any time.
  public var state: ClientState {
    ClientState(rawValue: client.currentStateSnapshot()) ?? .idle
  }

  /// Synchronous snapshot of the held (or in-flight) session id, `nil` when idle/closed.
  public var sessionId: String? {
    client.currentSessionIdSnapshot()
  }

  /// This build's effective trust configuration -- see `docs/SECURITY.md#configuring-trust`.
  public var buildConfig: BuildConfig {
    let config = currentCordieriteBuildConfig()
    return BuildConfig(
      trust: config.trust,
      hasEmbeddedPins: config.hasEmbeddedPins,
      allowPrivateLanOnly: config.allowPrivateLanOnly
    )
  }

  // MARK: Listeners

  /// Subscribes to state, session, and error events in one call. The returned `Subscription` may be
  /// cancelled from any thread; letting it go out of scope does **not** unsubscribe -- call
  /// `cancel()` explicitly. Registration with the underlying actor happens asynchronously
  /// (`addListener` itself returns immediately); an event fired between this call returning and that
  /// registration completing is not missed for the state/session channels, since both replay from
  /// the same synchronous snapshot a caller can already read via `state`/`sessionId` -- this call
  /// only adds *future* notifications.
  @discardableResult
  public func addListener(_ listener: @escaping @Sendable (CordieriteEvent) -> Void) -> Subscription {
    let box = SubscriptionBox()
    let client = self.client
    Task {
      box.add(await client.onStateChange { event in listener(.stateChange(event)) })
      box.add(await client.onSessionChange { event in listener(.sessionChange(event)) })
      box.add(await client.onError { event in listener(.error(event)) })
    }
    return Subscription(box: box)
  }

  // MARK: Lease restore / lifecycle

  /// Starts recovery from the native process-memory resume lease. `Cordierite.shared`'s first access
  /// already calls this in the background; call it again yourself only if you constructed a client
  /// through some other path, or want to know synchronously (via the returned `Bool`) whether a
  /// resume attempt actually started.
  @discardableResult
  public func restoreSession() async -> Bool {
    await client.restoreSession()
  }

  /// Closes the socket, clears the lease, state -> `.closed`. Idempotent.
  public func disconnect() async {
    await client.disconnect()
  }
}

// MARK: - Supporting types

/// Mirrors `CordieriteClientState` under the name the phase-3 API sketch (issue #48) uses. Not a
/// distinct type: renaming `CordieriteClientState` itself would ripple into `CordieriteClient`'s own
/// public API and the RN bridge's `event.state.rawValue` reads, for no benefit to either.
public typealias ClientState = CordieriteClientState

/// This build's effective trust configuration, mirroring the module-internal
/// `CordieriteBuildConfig` (`CordieriteConnectionManager.swift`) under a public name a plain-app
/// caller can read without importing anything internal. See
/// `docs/SECURITY.md#reading-the-effective-configuration-at-runtime`.
public struct BuildConfig: Sendable, Equatable {
  public let trust: String
  public let hasEmbeddedPins: Bool
  public let allowPrivateLanOnly: Bool
}

/// One unified event stream for `addListener`, folding `CordieriteClient`'s three separate listener
/// channels into one enum so a plain app registers a single closure.
public enum CordieriteEvent: Sendable {
  case stateChange(CordieriteStateChangeEvent)
  case sessionChange(CordieriteSessionChangeEvent)
  case error(CordieriteUnifiedErrorEvent)
}

/// A handle returned by `Cordierite.register`. `remove()` unregisters the tool; letting this value
/// go out of scope does **not** -- `deinit` intentionally does nothing, so a caller that drops the
/// registration without calling `remove()` keeps the tool registered (matching the JS client's
/// `registerTool(...).remove()` contract, `packages/react-native/README.md`).
public struct ToolRegistration: Sendable {
  private let unregister: @Sendable () -> Void

  init(_ unregister: @escaping @Sendable () -> Void) {
    self.unregister = unregister
  }

  public func remove() {
    unregister()
  }
}

/// A handle returned by `Cordierite.addListener`. `cancel()` unsubscribes every channel it wired;
/// letting this value go out of scope does **not** -- there is deliberately no `deinit`-based
/// auto-removal, matching `ToolRegistration`.
public struct Subscription: Sendable {
  private let box: SubscriptionBox

  init(box: SubscriptionBox) {
    self.box = box
  }

  public func cancel() {
    box.cancel()
  }
}

/// Backs `Subscription`: the three `CordieriteDisposable` tokens `addListener` collects arrive
/// asynchronously (each `CordieriteClient.onXChange` call is itself an actor hop), so this box lets
/// `cancel()` be called immediately -- before, during, or after that wiring completes -- and still
/// dispose every token exactly once. `@unchecked Sendable` is justified by the single `NSLock`
/// guarding all mutable state, the same pattern `CordieriteToolRegistryStore` and
/// `CordieriteProcessResumeLeaseStore` already use for the same reason.
final class SubscriptionBox: @unchecked Sendable {
  private let lock = NSLock()
  private var disposables: [any CordieriteDisposable] = []
  private var cancelled = false

  func add(_ disposable: any CordieriteDisposable) {
    lock.lock()
    if cancelled {
      lock.unlock()
      disposable.dispose()
      return
    }
    disposables.append(disposable)
    lock.unlock()
  }

  func cancel() {
    lock.lock()
    let pending = disposables
    disposables = []
    cancelled = true
    lock.unlock()
    for disposable in pending { disposable.dispose() }
  }
}

// MARK: - [String: Any] <-> JSONValue boundary

/// Parses `inputSchema`/`outputSchema` (plain JSON Schema as `[String: Any]`) into the core's
/// `ToolDescriptor`, validating exactly like `parseToolDescriptor` does for the wire JSON form.
private func makeToolDescriptor(
  name: String,
  description: String,
  inputSchema: [String: Any]?,
  outputSchema: [String: Any]?,
  annotations: ToolAnnotations?,
  timeoutMs: Int?
) throws -> ToolDescriptor {
  func toJSONObject(_ dict: [String: Any]?, label: String) throws -> JSONObject? {
    guard let dict else { return nil }
    guard let converted = try? Cordierite.jsonValue(fromFoundation: dict), let object = converted.objectValue else {
      throw ToolDescriptorValidationError("Tool \"\(name)\" \(label) is not a valid JSON object.")
    }
    return object
  }

  let descriptor = ToolDescriptor(
    name: name,
    description: description,
    inputSchema: try toJSONObject(inputSchema, label: "inputSchema"),
    outputSchema: try toJSONObject(outputSchema, label: "outputSchema"),
    annotations: annotations,
    timeoutMs: timeoutMs
  )
  try validateToolDescriptor(descriptor)
  return descriptor
}

extension Cordierite {
  /// Converts a plain Foundation value (as a handler argument dictionary's values arrive, or as a
  /// caller-supplied schema/payload) into `JSONValue`, using the same shape `JSONSerialization`
  /// accepts: `NSNull`, `NSNumber` (bool and numeric, disambiguated by `CFGetTypeID` exactly like
  /// `JSONValue.from(foundation:)`), `String`, `[Any]`, `[String: Any]`. Throws on anything else
  /// (`Date`, `Data`, a custom type, ...) instead of silently coercing it to `null` --
  /// `JSONValue.from(foundation:)` itself can't be reused here for that reason, even though the
  /// accepted-shape logic is identical.
  static func jsonValue(fromFoundation value: Any) throws -> JSONValue {
    switch value {
    case is NSNull:
      return .null
    case let number as NSNumber:
      if CFGetTypeID(number) == CFBooleanGetTypeID() {
        return .bool(number.boolValue)
      }
      return .number(number.doubleValue)
    case let string as String:
      return .string(string)
    case let array as [Any]:
      return .array(try array.map { try jsonValue(fromFoundation: $0) })
    case let dict as [String: Any]:
      var out: JSONObject = [:]
      out.reserveCapacity(dict.count)
      for (key, value) in dict {
        out[key] = try jsonValue(fromFoundation: value)
      }
      return .object(out)
    default:
      throw CordieriteJSONError("Value of type \(type(of: value)) is not JSON-serializable.")
    }
  }

  /// Converts a tool handler's `Any?` return value to `JSONValue`, mapping a conversion failure to
  /// `tool_serialization_error` -- the exact wire error type `CordieriteClient`'s own
  /// `JSONValue.serialized()` check already produces for a `JSONValue` result that turns out
  /// non-finite (`respondSuccess`, `CordieriteClient+ToolInvocation.swift`) -- so a plain-app handler
  /// gets the same error type for the same class of mistake, regardless of which boundary caught it.
  static func jsonValue(fromToolResult result: Any?) throws -> JSONValue {
    guard let result else { return .null }
    guard let converted = try? jsonValue(fromFoundation: result) else {
      throw CordieriteToolHandlerError(
        type: "tool_serialization_error",
        message: "Cordierite tool result is not JSON-serializable."
      )
    }
    return converted
  }
}

#endif
