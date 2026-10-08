package dev.appduct

/** What the shim reports about the device, built like the native cores build it. */
data class ShimDevice(val manufacturer: String, val model: String, val os: String)

private val APPDUCT_QUERY = Regex("[?&]appduct=")

/**
 * The shim's state, free of Android and Flutter types so it runs in a JVM unit test.
 *
 * One instance per process ([shared]) holds the resume lease in memory: a hot restart keeps it and
 * the process ending drops it. The first engine to call [activate] owns the shim; a second engine
 * gets `owner: false` until the first detaches. Before an engine activates, no link is claimed and
 * nothing but the latest Appduct link is kept.
 */
class ShimState {
    private var owner: Any? = null
    private var sink: ((String) -> Unit)? = null
    private var lease: String? = null
    private var pendingLink: String? = null

    @Synchronized
    fun activate(engine: Any, device: ShimDevice, sink: (String) -> Unit): Map<String, Any?> {
        if (owner != null && owner !== engine) return mapOf("owner" to false)
        owner = engine
        this.sink = sink
        val links = listOfNotNull(pendingLink)
        pendingLink = null
        return mapOf(
            "owner" to true,
            "links" to links,
            "lease" to lease,
            "device" to mapOf("manufacturer" to device.manufacturer, "model" to device.model, "os" to device.os),
        )
    }

    /** Drops [engine]'s claim, keeping the lease for the next engine. */
    @Synchronized
    fun release(engine: Any) {
        if (owner !== engine) return
        owner = null
        sink = null
    }

    @Synchronized
    fun writeLease(engine: Any, value: String) {
        if (owner === engine) lease = value
    }

    @Synchronized
    fun clearLease(engine: Any) {
        if (owner === engine) lease = null
    }

    /** Returns whether the shim took [url]; a URL without an `appduct` query value is never taken. */
    @Synchronized
    fun onLink(url: String): Boolean {
        if (!APPDUCT_QUERY.containsMatchIn(url.substringBefore('#'))) return false
        val target = sink
        if (target == null) {
            pendingLink = url
            return false
        }
        target(url)
        return true
    }

    companion object {
        val shared = ShimState()
    }
}
