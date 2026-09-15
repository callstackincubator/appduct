package com.callstackincubator.appduct

import android.os.Handler
import android.os.Looper
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner

/**
 * Foreground/background observation seam backing [AppductClient]'s "pause reconnect while
 * backgrounded, retry immediately on foreground" rule -- the Android mirror of `client/index.ts`'s
 * `AppState` handling. A fake implementation drives tests without a real `Lifecycle`.
 */
internal interface AppductAppLifecycleObserver {
    fun currentlyBackgrounded(): Boolean

    /** Stops observing. Safe to call more than once. */
    fun dispose()
}

/**
 * Real implementation, backed by `androidx.lifecycle:lifecycle-process`'s
 * [ProcessLifecycleOwner] -- a single process-wide `Lifecycle` that reaches `ON_STOP` only once
 * *every* activity has stopped (true backgrounding), unlike a single `Activity`'s own lifecycle,
 * which stops on every rotation and on transient system dialogs. `ProcessLifecycleOwner` must be
 * touched on the main thread, so registration/removal is posted to the main looper; the app must
 * still be a real Android process (this constructor is never exercised by [AppductClient]'s
 * unit tests, which inject [AppductNoopLifecycleObserver] instead).
 */
internal class AppductProcessLifecycleObserver(
    private val onBackgroundedChanged: (Boolean) -> Unit,
) : AppductAppLifecycleObserver,
    DefaultLifecycleObserver {
    @Volatile
    private var backgrounded = false

    private val mainHandler = Handler(Looper.getMainLooper())

    init {
        runOnMainThread { ProcessLifecycleOwner.get().lifecycle.addObserver(this) }
    }

    override fun onStart(owner: LifecycleOwner) {
        backgrounded = false
        onBackgroundedChanged(false)
    }

    override fun onStop(owner: LifecycleOwner) {
        backgrounded = true
        onBackgroundedChanged(true)
    }

    override fun currentlyBackgrounded(): Boolean = backgrounded

    override fun dispose() {
        runOnMainThread { ProcessLifecycleOwner.get().lifecycle.removeObserver(this) }
    }

    private fun runOnMainThread(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            block()
        } else {
            mainHandler.post(block)
        }
    }
}

/** Never reports backgrounded and never calls back -- used by [AppductClient]'s plain-JVM unit
 * tests, and by any host that manages its own foreground/background policy. */
internal class AppductNoopLifecycleObserver : AppductAppLifecycleObserver {
    override fun currentlyBackgrounded(): Boolean = false

    override fun dispose() {}
}
