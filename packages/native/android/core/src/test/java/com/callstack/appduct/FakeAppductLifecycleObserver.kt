package com.callstack.appduct

/**
 * Scripted [AppductAppLifecycleObserver] driving [AppductClient] tests on the plain JVM -- lets a
 * test simulate the app returning to the foreground without a real `Lifecycle`/`ProcessLifecycleOwner`,
 * beside [AppductNoopLifecycleObserver] (which can never do that at all).
 */
internal class FakeAppductLifecycleObserver(
    private val onBackgroundedChanged: (Boolean) -> Unit,
    startBackgrounded: Boolean = false,
) : AppductAppLifecycleObserver {
    @Volatile private var backgrounded = startBackgrounded

    override fun currentlyBackgrounded(): Boolean = backgrounded

    override fun dispose() {}

    /** Test-side trigger: flips the observed state and notifies the client, exactly like a real
     * `onStart`/`onStop` lifecycle callback would. */
    fun simulateForegroundChange(background: Boolean) {
        backgrounded = background
        onBackgroundedChanged(background)
    }
}
