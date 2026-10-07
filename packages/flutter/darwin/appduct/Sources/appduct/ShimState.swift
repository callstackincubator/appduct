import Foundation

/// What the shim reports about the device, built like the native cores build it.
public struct ShimDevice {
  public let manufacturer: String
  public let model: String
  public let os: String

  public init(manufacturer: String, model: String, os: String) {
    self.manufacturer = manufacturer
    self.model = model
    self.os = os
  }
}

/// The shim's state, free of UIKit and Flutter types so it runs in a plain `swift test`.
///
/// One instance per process (`shared`) holds the resume lease in memory: a hot restart keeps it
/// and the process ending drops it. The first engine to call `activate` owns the shim; a second
/// engine gets `owner: false` until the first detaches (iOS only: macOS never tells a plugin its
/// engine went away, so there the first engine owns the shim for the life of the process). Before an engine activates, no link is
/// claimed and nothing but the latest Appduct link is kept.
public final class ShimState {
  public static let shared = ShimState()

  private let lock = NSLock()
  private var owner: AnyObject?
  private var sink: ((String) -> Void)?
  private var lease: String?
  private var pendingLink: String?

  public init() {}

  public func activate(
    engine: AnyObject, device: ShimDevice, sink: @escaping (String) -> Void
  ) -> [String: Any?] {
    lock.lock()
    defer { lock.unlock() }
    if let owner = owner, owner !== engine { return ["owner": false] }
    owner = engine
    self.sink = sink
    let links = pendingLink.map { [$0] } ?? []
    pendingLink = nil
    return [
      "owner": true,
      "links": links,
      "lease": lease,
      "device": ["manufacturer": device.manufacturer, "model": device.model, "os": device.os],
    ]
  }

  /// Drops `engine`'s claim, keeping the lease for the next engine.
  public func release(engine: AnyObject) {
    lock.lock()
    defer { lock.unlock() }
    guard owner === engine else { return }
    owner = nil
    sink = nil
  }

  public func writeLease(engine: AnyObject, lease: String) {
    lock.lock()
    defer { lock.unlock() }
    if owner === engine { self.lease = lease }
  }

  public func clearLease(engine: AnyObject) {
    lock.lock()
    defer { lock.unlock() }
    if owner === engine { lease = nil }
  }

  /// Returns whether the shim took `url`; a URL without an `appduct` query value is never taken.
  @discardableResult
  public func onLink(_ url: String) -> Bool {
    let withoutFragment = url.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false)[0]
    guard withoutFragment.range(of: "[?&]appduct=", options: .regularExpression) != nil else {
      return false
    }
    lock.lock()
    let target = sink
    if target == nil { pendingLink = url }
    lock.unlock()
    guard let target = target else { return false }
    target(url)
    return true
  }
}
