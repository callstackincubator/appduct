import Foundation

#if os(iOS)
  import Flutter
  import UIKit
#else
  import FlutterMacOS
#endif

/// The `dev.appduct/shim` channel. On iOS it claims an Appduct URL from both the scene delegate
/// and the app delegate, on macOS from the app delegate; any other URL passes through.
public class AppductPlugin: NSObject, FlutterPlugin {
  private let state = ShimState.shared
  private var channel: FlutterMethodChannel?

  public static func register(with registrar: FlutterPluginRegistrar) {
    #if os(iOS)
      let messenger = registrar.messenger()
    #else
      let messenger = registrar.messenger
    #endif
    let instance = AppductPlugin()
    let channel = FlutterMethodChannel(name: "dev.appduct/shim", binaryMessenger: messenger)
    instance.channel = channel
    registrar.addMethodCallDelegate(instance, channel: channel)
    registrar.addApplicationDelegate(instance)
    #if os(iOS)
      registrar.addSceneDelegate(instance)
    #endif
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    state.release(engine: self)
    channel = nil
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "activate":
      result(
        state.activate(engine: self, device: Self.device()) { [weak self] link in
          DispatchQueue.main.async { self?.channel?.invokeMethod("link", arguments: link) }
        })
    case "writeLease":
      guard let lease = call.arguments as? String else {
        result(
          FlutterError(
            code: "bad_argument", message: "writeLease takes the lease as a string", details: nil))
        return
      }
      state.writeLease(engine: self, lease: lease)
      result(nil)
    case "clearLease":
      state.clearLease(engine: self)
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  #if os(iOS)
    public func application(
      _ application: UIApplication, open url: URL,
      options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
      state.onLink(url.absoluteString)
    }

    public func scene(
      _ scene: UIScene, willConnectTo session: UISceneSession,
      options connectionOptions: UIScene.ConnectionOptions?
    ) -> Bool {
      var claimed = false
      for context in connectionOptions?.urlContexts ?? [] {
        claimed = state.onLink(context.url.absoluteString) || claimed
      }
      return claimed
    }

    public func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) -> Bool {
      var claimed = false
      for context in URLContexts {
        claimed = state.onLink(context.url.absoluteString) || claimed
      }
      return claimed
    }
  #else
    public func handleOpen(_ urls: [URL]) -> Bool {
      var claimed = false
      for url in urls { claimed = state.onLink(url.absoluteString) || claimed }
      return claimed
    }
  #endif

  private static func device() -> ShimDevice {
    #if os(iOS)
      let device = UIDevice.current
      let model: String
      switch device.userInterfaceIdiom {
      case .phone: model = "iPhone"
      case .pad: model = "iPad"
      case .tv: model = "Apple TV"
      case .mac: model = "Mac"
      default: model = device.model
      }
      return ShimDevice(
        manufacturer: "Apple", model: model, os: "\(device.systemName) \(device.systemVersion)")
    #else
      return ShimDevice(
        manufacturer: "Apple", model: "Mac",
        os: "macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
    #endif
  }
}

#if os(iOS)
  // `addSceneDelegate` takes a `FlutterSceneLifeCycleDelegate`, which `FlutterPlugin` does not
  // imply on iOS. The `scene(...)` methods above satisfy it.
  extension AppductPlugin: FlutterSceneLifeCycleDelegate {}
#endif
