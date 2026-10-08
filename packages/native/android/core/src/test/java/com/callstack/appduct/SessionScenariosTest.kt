@file:OptIn(ExperimentalCoroutinesApi::class)

package com.callstack.appduct

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Replays `packages/native/fixtures/session-scenarios.json` through [AppductClient], the way
 * `SessionScenariosTests.swift` replays it through the Swift core and
 * `packages/web/src/__tests__/session-scenarios.test.ts` through the web core. The format is
 * documented in `packages/native/fixtures/README.md`: each step drives the client or expects the
 * next output of one of two ordered channels, wire (`connect`, `send`) and app (`state`,
 * `session`, `call`, `cancel`). Order between the channels is not asserted.
 *
 * The client runs on a [StandardTestDispatcher] and reads its clock from the same scheduler, so a
 * scenario takes no wall-clock time and every output is there, or never will be, once a step has
 * run the scheduler.
 */
class SessionScenariosTest {
    @Test
    fun `replays every scenario in session-scenarios json`() {
        val scenarios = JSONArray(File(fixturesDir(), "session-scenarios.json").readText(Charsets.UTF_8))
        assertTrue("session-scenarios.json has no scenarios", scenarios.length() > 0)

        val failures = mutableListOf<String>()
        for (index in 0 until scenarios.length()) {
            try {
                ScenarioReplay(scenarios.getJSONObject(index)).run()
            } catch (e: ScenarioFailure) {
                failures.add(e.message.orEmpty())
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    // --- the runner itself ---

    private val ack =
        """{"type":"session_ack","session_id":"session-1","status":"ok","alias":"phone","resume_token":"resume-1","keepalive_interval_s":15,"grace_s":10}"""
    private val claimThenActive =
        listOf(
            """{"drive":"connect","sessionId":"session-1","token":"claim-token","expiresAt":1700000300}""",
            """{"expect":"connect","mode":"claim","sessionId":"session-1"}""",
            """{"expect":"state","state":"connecting"}""",
            """{"drive":"receive","frame":$ack}""",
            """{"expect":"state","state":"active"}""",
            """{"expect":"session","type":"claimed"}""",
        )

    // Same frame as the fixtures' snapshot step, with its keys in another order.
    private val snapshot = """{"expect":"send","frame":{"tools":[],"session_id":"session-1","type":"tool_registry_snapshot"}}"""

    private fun scenarioOf(steps: List<String>) =
        JSONObject("""{"name":"inline","startMs":1700000000000,"random":0.5,"steps":[${steps.joinToString(",")}]}""")

    /** Fails the test unless replaying [scenario] throws a message containing [fragment]. */
    private fun assertReplayFails(
        scenario: JSONObject,
        fragment: String,
    ) {
        val failure =
            (
                try {
                    ScenarioReplay(scenario).run()
                    null
                } catch (e: ScenarioFailure) {
                    e
                }
            ) ?: throw AssertionError("expected the replay to fail")
        assertTrue("${failure.message} does not contain $fragment", failure.message.orEmpty().contains(fragment))
    }

    @Test
    fun `the runner passes a scenario whose frame keys are in another order`() {
        ScenarioReplay(scenarioOf(claimThenActive + snapshot)).run()
    }

    @Test
    fun `the runner passes a tool call answered by the app`() {
        val steps =
            listOf("""{"drive":"registerTool","descriptor":{"name":"echo","description":"Echoes."}}""") +
                claimThenActive +
                listOf(
                    """{"expect":"send","frame":{"type":"tool_registry_snapshot","session_id":"session-1","tools":[{"name":"echo","description":"Echoes."}]}}""",
                    """{"drive":"receive","frame":{"type":"tool_call","session_id":"session-1","id":"call-1","name":"echo","args":{"a":1}}}""",
                    """{"expect":"call","name":"echo","args":{"a":1}}""",
                    """{"drive":"respond","call":"call-1","result":{"ok":true}}""",
                    """{"expect":"send","frame":{"type":"tool_result","session_id":"session-1","id":"call-1","result":{"ok":true}}}""",
                )
        ScenarioReplay(scenarioOf(steps)).run()
    }

    @Test
    fun `the runner fails a scenario that expects an output the client never produces`() {
        val missing = scenarioOf(claimThenActive + snapshot + """{"expect":"state","state":"closed"}""")
        assertReplayFails(missing, "nothing arrived")
    }

    @Test
    fun `the runner fails a scenario that leaves an output unexpected`() {
        assertReplayFails(scenarioOf(claimThenActive), "left over")
    }

    @Test
    fun `the runner fails a scenario that expects two outputs of one channel in the wrong order`() {
        val swapped =
            claimThenActive.take(2) +
                """{"expect":"state","state":"active"}""" +
                """{"expect":"state","state":"connecting"}""" +
                claimThenActive.drop(3)
        assertReplayFails(scenarioOf(swapped), "step 3")
    }

    private companion object {
        /** `packages/native/fixtures`: `../../fixtures` from the module directory Gradle runs the
         * tests in, else the nearest ancestor of it that has the directory. */
        fun fixturesDir(): File {
            val userDir = File(System.getProperty("user.dir") ?: ".").canonicalFile
            val direct = File(userDir, "../../fixtures").canonicalFile
            if (direct.isDirectory) return direct

            var dir: File? = userDir
            while (dir != null) {
                val candidate = File(dir, "packages/native/fixtures")
                if (candidate.isDirectory) return candidate
                dir = dir.parentFile
            }
            throw IllegalStateException("Could not locate packages/native/fixtures from user.dir=$userDir.")
        }
    }
}

// --- replay ---

private class ScenarioFailure(message: String) : Exception(message)

/** A value in a form where two JSON values compare equal when they differ only in key order or
 * in how a number is boxed. */
private fun canonical(value: Any?): Any? =
    when (value) {
        JSONObject.NULL -> null
        is JSONObject -> value.keys().asSequence().associate { key -> key to canonical(value.get(key)) }
        is JSONArray -> (0 until value.length()).map { canonical(value.get(it)) }
        is Number -> value.toDouble()
        else -> value
    }

/**
 * Plays one scenario against a fresh [AppductClient] over [FakeAppductTransport] on a test
 * scheduler. Throws [ScenarioFailure] instead of failing the test, so a test can assert that a
 * scenario is rejected.
 */
private class ScenarioReplay(private val scenario: JSONObject) {
    private val scheduler = TestCoroutineScheduler()
    private val dispatcher = StandardTestDispatcher(scheduler)
    private val startMs = scenario.getLong("startMs")
    private val jitter = scenario.getDouble("random")
    private lateinit var fake: FakeAppductTransport
    private val client =
        AppductClient(
            transportFactory = { _, onMessage, onError, onClose ->
                FakeAppductTransport(onMessage, onError, onClose).also { fake = it }
            },
            dispatcher = dispatcher,
            clock = AppductClock { startMs + scheduler.currentTime },
            random = { jitter },
        )

    /** Runs `connect` and `disconnect`, which suspend, outside the test's own thread of control. */
    private val driver = CoroutineScope(SupervisorJob() + dispatcher)
    private val app = ArrayDeque<JSONObject>()
    private val responses = HashMap<String, CompletableDeferred<Any?>>()
    private var wireCursor = 0

    fun run() {
        try {
            play()
        } finally {
            driver.cancel()
            client.destroy()
        }
    }

    private fun play() {
        val name = scenario.getString("name")
        client.addStateChangeListener { state, reason ->
            app.addLast(JSONObject().put("kind", "state").put("state", state.name).also { if (reason != null) it.put("reason", reason) })
        }
        client.addSessionChangeListener { type, _, _, reason ->
            app.addLast(JSONObject().put("kind", "session").put("type", type).also { if (reason != null) it.put("reason", reason) })
        }

        val steps = scenario.getJSONArray("steps")
        for (index in 0 until steps.length()) {
            val step = steps.getJSONObject(index)
            val label = "$name, step ${index + 1}"
            if (step.has("drive")) {
                drive(step.getString("drive"), step, label)
                scheduler.runCurrent()
            } else {
                expect(step, label)
            }
        }

        scheduler.runCurrent()
        val leftover = mutableListOf<String>()
        while (true) {
            val item = nextWire() ?: break
            leftover.add(item.toString())
        }
        while (true) {
            val item = app.removeFirstOrNull() ?: break
            leftover.add(item.toString())
        }
        if (leftover.isNotEmpty()) {
            throw ScenarioFailure("$name: the steps ran out with outputs left over: $leftover")
        }
    }

    // --- drive ---

    private fun drive(
        kind: String,
        step: JSONObject,
        label: String,
    ) {
        when (kind) {
            "connect" -> {
                val input =
                    AppductConnectInput.Explicit(
                        ip = "127.0.0.1",
                        port = 8443,
                        sessionId = step.getString("sessionId"),
                        token = step.getString("token"),
                        expiresAt = step.getLong("expiresAt"),
                    )
                driver.launch { runCatching { client.connect(input) } }
            }

            "receive" -> {
                val frame = step.getJSONObject("frame")
                if (frame.optString("type") == "session_ack") fake.rawState = "active"
                fake.simulateMessage(frame)
            }

            "close" ->
                fake.simulateClose(
                    if (step.has("code")) step.getInt("code") else null,
                    if (step.has("reason")) step.getString("reason") else null,
                )

            "drop" -> fake.simulateClose(null, null)

            "advance" -> {
                // Let the client arm its timers before time moves.
                scheduler.runCurrent()
                scheduler.advanceTimeBy(step.getLong("ms"))
            }

            "registerTool" ->
                client.registerTool(AppductToolDescriptor.fromJson(step.getJSONObject("descriptor").toString()), callHandler())

            "respond" -> {
                val response = responses.getOrPut(step.getString("call")) { CompletableDeferred() }
                if (step.has("error")) {
                    val error = step.getJSONObject("error")
                    response.completeExceptionally(AppductToolReplyError(error.getString("type"), error.getString("message")))
                } else {
                    response.complete(step.get("result"))
                }
            }

            "disconnect" -> driver.launch { client.disconnect() }

            else -> throw ScenarioFailure("$label: unknown drive step \"$kind\"")
        }
    }

    /** Reports the call on the app channel, then waits for the scenario's `respond`. When the client
     * cancels the call, reports that with the reason the client gave. */
    private fun callHandler(): AppductToolHandler =
        { args, context ->
            app.addLast(JSONObject().put("kind", "call").put("name", context.toolName).put("args", args))
            val response = responses.getOrPut(context.callId) { CompletableDeferred() }
            try {
                response.await()
            } catch (e: CancellationException) {
                app.addLast(
                    JSONObject()
                        .put("kind", "cancel")
                        .put("call", context.callId)
                        .put("reason", if (e is TimeoutCancellationException) "timeout" else e.message ?: "unknown"),
                )
                throw e
            }
        }

    // --- expect ---

    private fun expect(
        step: JSONObject,
        label: String,
    ) {
        val kind = step.getString("expect")
        val wanted = JSONObject(step.toString()).also { it.remove("expect") }.put("kind", kind)

        // Virtual time: an output that is not there once the scheduler has run will not arrive.
        scheduler.runCurrent()
        val got =
            when (kind) {
                "connect", "send" -> nextWire()
                "state", "session", "call", "cancel" -> app.removeFirstOrNull()
                else -> throw ScenarioFailure("$label: unknown expect step \"$kind\"")
            } ?: throw ScenarioFailure("$label: expected $wanted but nothing arrived")
        if (canonical(got) != canonical(wanted)) {
            throw ScenarioFailure("$label: expected $wanted but got $got")
        }
    }

    /** The next thing the client asked of the transport, as the `connect` or `send` output a step
     * spells out. */
    private fun nextWire(): JSONObject? {
        if (wireCursor >= fake.wireEvents.size) return null
        return when (val event = fake.wireEvents[wireCursor++]) {
            is FakeWireEvent.Connect ->
                JSONObject()
                    .put("kind", "connect")
                    .put("mode", if (event.options["resumeToken"] == null) "claim" else "resume")
                    .put("sessionId", event.options["sessionId"])
                    .also { output -> event.options["resumeToken"]?.let { output.put("resumeToken", it) } }

            is FakeWireEvent.Send -> JSONObject().put("kind", "send").put("frame", JSONObject(event.text))
        }
    }
}
