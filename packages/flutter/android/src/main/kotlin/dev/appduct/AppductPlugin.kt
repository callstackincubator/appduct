package dev.appduct

import android.content.Intent
import android.os.Build
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry

/**
 * The `dev.appduct/shim` channel. It watches the launch intent and new intents but cannot consume
 * them, so Flutter's own routing still sees the link and the Dart route guard drops it.
 */
class AppductPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private val state = ShimState.shared
    private var channel: MethodChannel? = null
    private var activity: ActivityPluginBinding? = null
    private val newIntentListener = PluginRegistry.NewIntentListener { intent ->
        observe(intent)
        false
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel = MethodChannel(binding.binaryMessenger, "dev.appduct/shim").also {
            it.setMethodCallHandler(this)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        state.release(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "activate" -> result.success(
                state.activate(this, device()) { link -> channel?.invokeMethod("link", link) },
            )
            "writeLease" -> {
                val lease = call.arguments as? String
                if (lease == null) {
                    result.error("bad_argument", "writeLease takes the lease as a string", null)
                } else {
                    state.writeLease(this, lease)
                    result.success(null)
                }
            }
            "clearLease" -> {
                state.clearLease(this)
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding
        binding.addOnNewIntentListener(newIntentListener)
        observe(binding.activity.intent)
    }

    override fun onDetachedFromActivityForConfigChanges() = onDetachedFromActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding
        binding.addOnNewIntentListener(newIntentListener)
    }

    override fun onDetachedFromActivity() {
        activity?.removeOnNewIntentListener(newIntentListener)
        activity = null
    }

    private fun observe(intent: Intent?) {
        intent?.dataString?.let { state.onLink(it) }
    }

    private fun device(): ShimDevice {
        fun clean(value: String?) = value?.trim()?.takeIf { it.isNotEmpty() } ?: "Unknown"
        val release = Build.VERSION.RELEASE?.trim().orEmpty()
        return ShimDevice(
            manufacturer = clean(Build.MANUFACTURER),
            model = clean(Build.MODEL),
            os = if (release.isNotEmpty()) "Android $release" else "Android",
        )
    }
}
