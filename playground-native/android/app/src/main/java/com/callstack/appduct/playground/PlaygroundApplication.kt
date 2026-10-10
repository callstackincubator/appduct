package com.callstack.appduct.playground

import android.app.Application
import com.callstack.appduct.Appduct
import com.callstack.appduct.AppductEvent
import com.callstack.appduct.SessionChangeType
import com.callstack.appduct.ToolAnnotations
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * Registers the tools and the event of the playground contract
 * (`docs/internal/playground-contract.md`) so every playground can be driven identically from
 * `appduct tools ls`/`tools call`.
 * By the time [onCreate] runs, [com.callstack.appduct.AppductInitProvider] has
 * already captured this process's application `Context` and started lease recovery -- nothing
 * else needs to happen before [Appduct.register] works.
 *
 * On a release build (`releaseImplementation` resolves `core-noop`, see `app/build.gradle`),
 * every call below still compiles and runs, but does nothing: `Appduct.register` returns an
 * inert [com.callstack.appduct.ToolRegistration] and the listener below is never
 * invoked, matching every other Appduct consumer's compiled-out release behavior
 * (https://callstackincubator.github.io/appduct/guides/build-variants/).
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
                    PlaygroundState.alias = if (event.type == SessionChangeType.lost) null else event.alias
                    PlaygroundState.lastSessionEvent =
                        event.type.name + (event.reason?.let { " ($it)" } ?: "")
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
        // Declared before any link, so `events ls` lists it from app start.
        Appduct.registerEvent(
            name = "playground_ping",
            description = "The Send playground_ping button on the Status screen was pressed.",
            payloadSchema = JSONObject(
                """{"type":"object","properties":{"at":{"type":"number","description":"Press time, milliseconds since the epoch"}},"required":["at"]}""",
            ),
        )

        Appduct.register(
            name = "sum",
            description = "Adds two numbers. Counts as a call in call_count.",
            inputSchema = JSONObject(
                """{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}""",
            ),
            outputSchema = JSONObject("""{"type":"object","properties":{"total":{"type":"number"}}}"""),
        ) { args ->
            PlaygroundState.callCount += 1
            PlaygroundState.logEvent("tool sum(${args.optDouble("a")}, ${args.optDouble("b")})")
            JSONObject().put("total", args.getDouble("a") + args.getDouble("b"))
        }

        Appduct.register(
            name = "call_count",
            description = "Reports how many times the counted tools (sum, slow_task) have run. Read-only.",
            outputSchema = JSONObject("""{"type":"object","properties":{"count":{"type":"number"}}}"""),
            annotations = ToolAnnotations(readOnlyHint = true),
            group = "counter",
        ) { _ ->
            JSONObject().put("count", PlaygroundState.callCount)
        }

        Appduct.register(
            name = "reset_counter",
            description = "Resets the call counter to zero. Destructive; a no-op when it is already zero.",
            outputSchema = JSONObject("""{"type":"object","properties":{"count":{"type":"number"}}}"""),
            annotations = ToolAnnotations(destructiveHint = true, idempotentHint = true),
            group = "counter",
        ) { _ ->
            PlaygroundState.callCount = 0
            PlaygroundState.logEvent("tool reset_counter()")
            JSONObject().put("count", 0)
        }

        Appduct.register(
            name = "slow_task",
            description = "Takes about 1.5 s and reports progress along the way. Counts as a call in call_count.",
            outputSchema = JSONObject("""{"type":"object","properties":{"done":{"type":"boolean"}}}"""),
            timeoutMs = 5_000,
            group = "diagnostics/progress",
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
            description = "Always fails with tool_execution_error. Changes nothing.",
            annotations = ToolAnnotations(readOnlyHint = true),
            group = "diagnostics",
        ) { _ ->
            throw RuntimeException("throwing_tool always fails on purpose.")
        }
    }
}
