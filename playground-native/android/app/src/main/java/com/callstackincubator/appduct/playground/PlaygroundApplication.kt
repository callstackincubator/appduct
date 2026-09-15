package com.callstackincubator.appduct.playground

import android.app.Application
import com.callstackincubator.appduct.Appduct
import com.callstackincubator.appduct.AppductEvent
import com.callstackincubator.appduct.ToolAnnotations
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * Registers the same tool set as the Expo playground (`playground/app/(tabs)/index.tsx`) so the
 * two can be driven identically from `appduct tools`/`invoke` (docs/tasks/19-android-entry-points.md).
 * By the time [onCreate] runs, [com.callstackincubator.appduct.AppductInitProvider] has
 * already captured this process's application `Context` and started lease recovery -- nothing
 * else needs to happen before [Appduct.register] works.
 *
 * On a release build (`releaseImplementation` resolves `core-noop`, see `app/build.gradle`),
 * every call below still compiles and runs, but does nothing: `Appduct.register` returns an
 * inert [com.callstackincubator.appduct.ToolRegistration] and the listener below is never
 * invoked, matching every other Appduct consumer's compiled-out release behavior
 * (`docs/BUILD-VARIANTS.md`).
 */
class PlaygroundApplication : Application() {
    override fun onCreate() {
        super.onCreate()

        Appduct.addListener { event ->
            when (event) {
                is AppductEvent.StateChange -> {
                    PlaygroundState.clientState = event.state
                    PlaygroundState.logEvent(
                        "state -> ${event.state}" + (event.reason?.let { " ($it)" } ?: ""),
                    )
                }
                is AppductEvent.SessionChange -> {
                    PlaygroundState.sessionId = event.sessionId
                    PlaygroundState.logEvent("session -> ${event.sessionId ?: "none"}")
                }
                is AppductEvent.Error -> {
                    PlaygroundState.logEvent("error[${event.phase}] ${event.message}")
                }
            }
        }

        registerTools()
    }

    private fun registerTools() {
        Appduct.register(
            name = "sum",
            description = "Adds two numbers.",
            inputSchema = JSONObject(
                """{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}""",
            ),
            outputSchema = JSONObject("""{"type":"object","properties":{"total":{"type":"number"}}}"""),
        ) { args ->
            PlaygroundState.callCount += 1
            PlaygroundState.logEvent("tool sum(${args.optInt("a")}, ${args.optInt("b")})")
            JSONObject().put("total", args.getInt("a") + args.getInt("b"))
        }

        Appduct.register(
            name = "call_count",
            description = "Reports how many times the playground's counted tools have run.",
            outputSchema = JSONObject("""{"type":"object","properties":{"count":{"type":"number"}}}"""),
            annotations = ToolAnnotations(readOnlyHint = true),
        ) { _ ->
            JSONObject().put("count", PlaygroundState.callCount)
        }

        Appduct.register(
            name = "reset_counter",
            description = "Resets the playground's call counter to zero.",
            outputSchema = JSONObject("""{"type":"object","properties":{"count":{"type":"number"}}}"""),
            annotations = ToolAnnotations(destructiveHint = true),
        ) { _ ->
            PlaygroundState.callCount = 0
            PlaygroundState.logEvent("tool reset_counter()")
            JSONObject().put("count", 0)
        }

        Appduct.register(
            name = "slow_task",
            description = "Takes ~1.5s and reports progress along the way.",
            outputSchema = JSONObject("""{"type":"object","properties":{"done":{"type":"boolean"}}}"""),
            timeoutMs = 5_000,
        ) { _, context ->
            for ((progress, message) in listOf(0.33 to "warming up", 0.66 to "almost there", 1.0 to "done")) {
                delay(500)
                context.reportProgress(progress, message)
            }
            PlaygroundState.callCount += 1
            PlaygroundState.logEvent("tool slow_task() done")
            JSONObject().put("done", true)
        }

        Appduct.register(
            name = "throwing_tool",
            description = "Always throws, to exercise tool_execution_error.",
        ) { _ ->
            throw RuntimeException("throwing_tool always fails on purpose.")
        }
    }
}
