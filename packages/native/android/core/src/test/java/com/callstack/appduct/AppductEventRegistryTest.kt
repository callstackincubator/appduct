package com.callstack.appduct

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

/**
 * Event registration (issue #127): `registerEvent` declares an event to the daemon with
 * `event_registry_snapshot`/`event_registry_delta` frames, sent only once an ack carried
 * `event_registry: true` (PROTOCOL.md §5a). Observed through the frames the fake transport saw.
 * Robolectric-backed only because the facade test goes through [Appduct].
 */
@RunWith(RobolectricTestRunner::class)
class AppductEventRegistryTest {
    private lateinit var client: AppductClient
    private lateinit var fake: FakeAppductTransport

    @Before
    fun setUp() {
        lateinit var transport: FakeAppductTransport
        client =
            AppductClient(
                transportFactory = { _, onMessage, onError, onClose ->
                    FakeAppductTransport(onMessage, onError, onClose).also { transport = it }
                },
                lifecycleObserverFactory = { AppductNoopLifecycleObserver() },
            )
        fake = transport
    }

    @After
    fun tearDown() {
        Appduct.detachForTest()
    }

    private fun connectAndAck(
        sessionId: String = "session-1",
        eventRegistry: Boolean,
    ) = runBlocking {
        val before = fake.connectCalls.size
        val job =
            launch(Dispatchers.Default) {
                client.connect(
                    AppductConnectInput.Explicit(
                        ip = "127.0.0.1",
                        port = 8443,
                        sessionId = sessionId,
                        token = "claim-token",
                        expiresAt = Long.MAX_VALUE / 2,
                    ),
                )
            }
        waitUntil { fake.connectCalls.size > before }
        fake.simulateAck(sessionId, graceS = 120.0, eventRegistry = eventRegistry)
        job.join()
    }

    private fun event(
        name: String,
        description: String = "An event.",
        payloadSchema: JSONObject? = null,
    ) = AppductEventDescriptor(name, description, payloadSchema)

    private fun frames(): List<JSONObject> = fake.sentMessages.map { JSONObject(it) }

    private fun eventFrames(): List<JSONObject> = frames().filter { it.getString("type").startsWith("event_registry_") }

    private fun waitForEventFrames(count: Int): List<JSONObject> {
        waitUntil { eventFrames().size >= count }
        return eventFrames()
    }

    private fun names(snapshot: JSONObject): List<String> =
        (0 until snapshot.getJSONArray("events").length()).map { snapshot.getJSONArray("events").getJSONObject(it).getString("name") }

    /** Sends a tool registration and waits for a tool frame carrying it (a delta, or the snapshot
     * of a session whose ack had not been handled yet): frames go out in call order, so once it is
     * out, an event frame that was going to be sent for an earlier call already was. */
    private fun settle() {
        client.registerTool(AppductToolDescriptor("settle_marker", "Marks the end of the frames.")) { _, _ -> null }
        waitUntil { fake.sentMessages.any { it.contains("settle_marker") } }
    }

    // --- snapshot after the ack ---

    @Test
    fun `an ack with the flag is followed by a snapshot of the declared events`() {
        client.registerEvent(event("app_ready"))
        client.registerEvent(event("cart.item_added"))
        connectAndAck(eventRegistry = true)

        val snapshot = waitForEventFrames(1).single()
        assertEquals("event_registry_snapshot", snapshot.getString("type"))
        assertEquals("session-1", snapshot.getString("session_id"))
        assertEquals(listOf("app_ready", "cart.item_added"), names(snapshot))
    }

    @Test
    fun `an ack with the flag and no declared events is followed by an empty snapshot`() {
        connectAndAck(eventRegistry = true)

        val snapshot = waitForEventFrames(1).single()
        assertEquals(0, snapshot.getJSONArray("events").length())
    }

    @Test
    fun `an ack without the flag sends no event frames, even for declared events`() {
        client.registerEvent(event("app_ready"))
        connectAndAck(eventRegistry = false)
        client.registerEvent(event("later"))
        client.unregisterEvent("later")
        settle()

        assertEquals(emptyList<JSONObject>(), eventFrames())
    }

    @Test
    fun `an event declared with no session sends nothing and is in the next snapshot`() {
        client.registerEvent(event("early"))
        assertEquals(0, fake.sentMessages.size)

        connectAndAck(eventRegistry = true)
        assertEquals(listOf("early"), names(waitForEventFrames(1).single()))
    }

    @Test
    fun `a resume ack with the flag is followed by a fresh snapshot`() {
        connectAndAck(eventRegistry = true)
        client.registerEvent(event("after_first_ack"))
        waitForEventFrames(2)

        val connectsBefore = fake.connectCalls.size
        fake.simulateClose(1006, null)
        waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectsBefore }
        fake.simulateAck("session-1", graceS = 120.0, eventRegistry = true)

        val all = waitForEventFrames(3)
        assertEquals("event_registry_snapshot", all[2].getString("type"))
        assertEquals(listOf("after_first_ack"), names(all[2]))
    }

    @Test
    fun `a resume ack without the flag sends no event frames`() {
        connectAndAck(eventRegistry = true)
        client.registerEvent(event("declared"))
        waitForEventFrames(2)

        val connectsBefore = fake.connectCalls.size
        fake.simulateClose(1006, null)
        waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectsBefore }
        fake.simulateAck("session-1", graceS = 120.0, eventRegistry = false)
        client.registerEvent(event("declared_again"))
        settle()

        assertEquals(2, eventFrames().size)
    }

    // --- deltas ---

    @Test
    fun `declaring an event on an active session with the flag sends an upsert delta`() {
        connectAndAck(eventRegistry = true)
        waitForEventFrames(1)

        client.registerEvent(event("checkout_completed", "Fired at checkout.", JSONObject("""{"type":"object"}""")))

        val delta = waitForEventFrames(2)[1]
        assertEquals("event_registry_delta", delta.getString("type"))
        assertEquals("upsert", delta.getString("operation"))
        assertEquals("checkout_completed", delta.getJSONObject("event").getString("name"))
        assertEquals("object", delta.getJSONObject("event").getJSONObject("payload_schema").getString("type"))
    }

    @Test
    fun `declaring a name twice keeps one event with the latest description`() {
        client.registerEvent(event("a", "first"))
        client.registerEvent(event("b"))
        client.registerEvent(event("a", "second"))
        connectAndAck(eventRegistry = true)

        val events = waitForEventFrames(1).single().getJSONArray("events")
        assertEquals(2, events.length())
        assertEquals("a", events.getJSONObject(0).getString("name"))
        assertEquals("second", events.getJSONObject(0).getString("description"))
    }

    @Test
    fun `removing an event sends a remove delta and drops it from the next snapshot`() {
        client.registerEvent(event("gone"))
        client.registerEvent(event("kept"))
        connectAndAck(eventRegistry = true)
        waitForEventFrames(1)

        client.unregisterEvent("gone")
        val delta = waitForEventFrames(2)[1]
        assertEquals("event_registry_delta", delta.getString("type"))
        assertEquals("remove", delta.getString("operation"))
        assertEquals("gone", delta.getString("name"))

        val connectsBefore = fake.connectCalls.size
        fake.simulateClose(1006, null)
        waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectsBefore }
        fake.simulateAck("session-1", graceS = 120.0, eventRegistry = true)
        assertEquals(listOf("kept"), names(waitForEventFrames(3)[2]))
    }

    @Test
    fun `removing an event that was never declared sends nothing`() {
        connectAndAck(eventRegistry = true)
        waitForEventFrames(1)

        client.unregisterEvent("never_declared")
        settle()

        assertEquals(1, eventFrames().size)
    }

    // --- validation ---

    @Test
    fun `an invalid descriptor is rejected and nothing is sent`() {
        connectAndAck(eventRegistry = true)
        waitForEventFrames(1)

        for (bad in listOf(event(""), event("x".repeat(4097)), event("a", ""), event("a", "x".repeat(4097)), event("😀".repeat(2049)))) {
            assertThrows(IllegalArgumentException::class.java) { client.registerEvent(bad) }
        }
        settle()

        assertEquals(1, eventFrames().size)
    }

    @Test
    fun `dotted names, names with spaces and 2048 non-BMP characters are accepted`() {
        for (name in listOf("cart.item_added", "has space", "😀".repeat(2048), "a".repeat(4096))) {
            client.registerEvent(event(name))
        }
    }

    // --- facade ---

    @Test
    fun `Appduct registerEvent declares an event and its registration removes it`() {
        Appduct.attachForTest(client)
        connectAndAck(eventRegistry = true)
        waitForEventFrames(1)

        val registration = Appduct.registerEvent("app_ready", "The app finished starting.")
        assertEquals("app_ready", registration.name)
        assertEquals("app_ready", waitForEventFrames(2)[1].getJSONObject("event").getString("name"))

        registration.remove()
        val remove = waitForEventFrames(3)[2]
        assertEquals("remove", remove.getString("operation"))
        assertEquals("app_ready", remove.getString("name"))
    }

    @Test
    fun `Appduct registerEvent throws for an invalid name`() {
        Appduct.attachForTest(client)
        assertThrows(IllegalArgumentException::class.java) { Appduct.registerEvent("", "x") }
    }

    // --- ordering ---

    @Test
    fun `a declaration made right after the ack is sent as a delta after the ack-time snapshot`() {
        fake.deferSendCompletion = true
        client.registerEvent(event("before"))
        connectAndAck(eventRegistry = true)

        client.registerEvent(event("after"))

        val sent = waitForEventFrames(2)
        settle()
        val all = eventFrames()
        assertEquals(listOf("event_registry_snapshot", "event_registry_delta"), all.map { it.getString("type") })
        assertEquals(listOf("before"), names(all[0]))
        assertEquals("after", all[1].getJSONObject("event").getString("name"))
        assertEquals(2, sent.size)
    }

    @Test
    fun `removing and re-registering one name in a loop ends with the upsert, in call order`() {
        fake.deferSendCompletion = true
        connectAndAck(eventRegistry = true)
        client.registerEvent(event("flip"))

        repeat(15) {
            client.unregisterEvent("flip")
            client.registerEvent(event("flip"))
        }

        waitForEventFrames(1 + 1 + 30)
        settle()
        val deltas = eventFrames().drop(1)
        assertEquals(31, deltas.size)
        assertEquals(
            listOf("upsert") + List(15) { listOf("remove", "upsert") }.flatten(),
            deltas.map { it.getString("operation") },
        )
        assertEquals("upsert", eventFrames().last().getString("operation"))
    }

    // --- event-registry-frames.json ---

    private fun fixtureFrames(): JSONArray {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").canonicalFile
        while (dir != null) {
            val candidate = File(dir, "packages/native/fixtures/event-registry-frames.json")
            if (candidate.isFile) return JSONArray(candidate.readText(Charsets.UTF_8))
            val direct = File(dir, "../../fixtures/event-registry-frames.json").canonicalFile
            if (direct.isFile) return JSONArray(direct.readText(Charsets.UTF_8))
            dir = dir.parentFile
        }
        throw IllegalStateException("event-registry-frames.json not found")
    }

    /** Key order is not significant on the wire, so compare a canonical rendering. */
    private fun canonical(value: Any?): String =
        when (value) {
            is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { "\"$it\":${canonical(value.get(it))}" }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
            else -> JSONObject.quote(value.toString())
        }

    @Test
    fun `the frames sent match every scenario in event-registry-frames fixture`() {
        val scenarios = fixtureFrames()
        assertTrue(scenarios.length() > 0)

        for (i in 0 until scenarios.length()) {
            setUp()
            val scenario = scenarios.getJSONObject(i)
            val name = scenario.getString("name")

            val declared = scenario.getJSONArray("declaredBeforeAck")
            for (j in 0 until declared.length()) {
                client.registerEvent(AppductEventDescriptor.fromJson(declared.getJSONObject(j).toString()))
            }
            connectAndAck(scenario.getString("sessionId"), eventRegistry = true)

            val expected = scenario.getJSONArray("frames")
            val steps = scenario.getJSONArray("afterAck")
            for (j in 0 until steps.length()) {
                val step = steps.getJSONObject(j)
                when (step.getString("op")) {
                    "register" -> client.registerEvent(AppductEventDescriptor.fromJson(step.getJSONObject("event").toString()))
                    "remove" -> client.unregisterEvent(step.getString("name"))
                    else -> throw AssertionError("$name: unknown step ${step.getString("op")}")
                }
            }

            waitForEventFrames(expected.length())
            settle()
            assertEquals(name, canonical(expected), canonical(JSONArray(eventFrames())))
        }
    }
}
