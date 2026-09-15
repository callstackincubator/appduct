package com.callstackincubator.appduct

import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Exercises the public [Appduct] facade (docs/tasks/19-android-entry-points.md) against a
 * scripted [FakeAppductTransport], substituted via [Appduct.attachForTest] instead of the
 * real [AppductInitProvider] path -- no real `Context`, no OkHttp. Complements
 * [AppductClientTest], which covers the same session/reconnect behaviors one layer down; this
 * suite only checks that the facade converts to/from [AppductClient]'s types correctly.
 * Robolectric-backed (like [AppductSpkiPinTest]) because [Appduct.handle] takes real
 * `android.net.Uri`/`android.content.Intent` values, both stubs that throw "not mocked" on the
 * plain-JVM `android.jar` [AppductClientTest] otherwise runs against.
 *
 * [Appduct] has no public `connect()` of its own (a plain app connects via a delivered
 * bootstrap link, per issue #48's Phase 3 design -- [Appduct.handle] is the only way in), so
 * [connectAndAck] drives the underlying [AppductClient] directly, the same way
 * [AppductClientTest] does, rather than adding test-only surface to the public facade.
 */
@RunWith(RobolectricTestRunner::class)
class AppductTest {
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
            )
        fake = transport
        Appduct.attachForTest(client)
    }

    @After
    fun tearDown() {
        Appduct.detachForTest()
    }

    /** Launches `connect()` on [client] directly, waits for the fake transport to observe the
     * attempt, then acks it. Returns once `connect()` has resolved. */
    private fun connectAndAck(sessionId: String = "sess-1") =
        runBlocking {
            val before = fake.connectCalls.size
            val job =
                kotlinx.coroutines.CoroutineScope(Dispatchers.Default).launch {
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
            fake.simulateAck(sessionId)
            job.join()
        }

    // --- registration ---

    @Test
    fun `register adds the descriptor to the snapshot sent on connect`() =
        runBlocking {
            Appduct.register(
                name = "sum",
                description = "Adds two numbers.",
                annotations = ToolAnnotations(readOnlyHint = true),
            ) { args -> JSONObject().put("total", args.getInt("a") + args.getInt("b")) }

            connectAndAck()

            waitUntil { fake.sentMessages.isNotEmpty() }
            val snapshot = JSONObject(fake.sentMessages.first())
            assertEquals("tool_registry_snapshot", snapshot.getString("type"))
            val tools = snapshot.getJSONArray("tools")
            assertEquals(1, tools.length())
            val tool = tools.getJSONObject(0)
            assertEquals("sum", tool.getString("name"))
            assertTrue(tool.getJSONObject("annotations").getBoolean("readOnlyHint"))
        }

    @Test
    fun `a registered handler runs and its result reaches the wire`() =
        runBlocking {
            Appduct.register(name = "sum", description = "Adds two numbers.") { args ->
                JSONObject().put("total", args.getInt("a") + args.getInt("b"))
            }
            connectAndAck()
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject()
                    .put("type", "tool_call")
                    .put("session_id", "sess-1")
                    .put("id", "call-1")
                    .put("name", "sum")
                    .put("args", JSONObject().put("a", 2).put("b", 3)),
            )

            waitUntil { fake.sentMessages.isNotEmpty() }
            val result = JSONObject(fake.sentMessages.first())
            assertEquals("tool_result", result.getString("type"))
            assertEquals(5, result.getJSONObject("result").getInt("total"))
        }

    @Test
    fun `the two-arg register overload's context reports progress`() =
        runBlocking {
            Appduct.register(name = "slow", description = "Reports progress.") { _, context ->
                context.reportProgress(0.5, "halfway")
                JSONObject()
            }
            connectAndAck()
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject()
                    .put("type", "tool_call")
                    .put("session_id", "sess-1")
                    .put("id", "call-1")
                    .put("name", "slow")
                    .put("args", JSONObject()),
            )

            waitUntil { fake.sentMessages.any { JSONObject(it).optString("type") == "tool_call_progress" } }
            val progress = fake.sentMessages.map { JSONObject(it) }.first { it.getString("type") == "tool_call_progress" }
            assertEquals(0.5, progress.getDouble("progress"), 0.0001)
            assertEquals("halfway", progress.getString("message"))
        }

    @Test
    fun `remove unregisters the tool and sends a delta while active`() =
        runBlocking {
            val registration = Appduct.register(name = "sum", description = "Adds two numbers.") { _ -> null }
            connectAndAck()
            fake.sentMessages.clear()

            registration.remove()

            waitUntil { fake.sentMessages.isNotEmpty() }
            val delta = JSONObject(fake.sentMessages.first())
            assertEquals("tool_registry_delta", delta.getString("type"))
            assertEquals("remove", delta.getString("operation"))
            assertEquals("sum", delta.getString("name"))
        }

    // --- deep links ---

    @Test
    fun `handle(Uri) routes an appduct bootstrap link into the client`() {
        val bootstrapUri = Uri.parse("appduct://bootstrap?appduct=not-a-real-payload")
        assertTrue(Appduct.handle(bootstrapUri))
    }

    @Test
    fun `handle(Uri) returns false for a URI with no appduct payload`() {
        val other = Uri.parse("appduct://bootstrap?nothing=here")
        assertFalse(Appduct.handle(other))
    }

    @Test
    fun `handle(Intent) reads intent data and returns false for a null data URI`() {
        assertFalse(Appduct.handle(Intent()))
    }

    // --- listeners / state ---

    @Test
    fun `addListener receives a StateChange once connect acks`() =
        runBlocking {
            val events = mutableListOf<AppductEvent>()
            val subscription = Appduct.addListener { events.add(it) }

            connectAndAck()

            waitUntil {
                events.any { it is AppductEvent.StateChange && it.state == ClientState.active }
            }
            subscription.remove()
        }

    @Test
    fun `state and sessionId reflect the underlying client`() =
        runBlocking {
            assertEquals(ClientState.idle, Appduct.state)
            assertNull(Appduct.sessionId)

            connectAndAck()

            assertEquals(ClientState.active, Appduct.state)
            assertEquals("sess-1", Appduct.sessionId)
        }

    @Test
    fun `buildConfig mirrors the transport's build config`() {
        fake.buildConfigValue = AppductBuildConfig(trust = "pin", hasEmbeddedPins = true, allowPrivateLanOnly = true)
        val config = Appduct.buildConfig
        assertEquals("pin", config.trust)
        assertTrue(config.hasEmbeddedPins)
        assertTrue(config.allowPrivateLanOnly)
    }

    @Test(expected = IllegalStateException::class)
    fun `calling before attach throws a clear error`() {
        Appduct.detachForTest()
        Appduct.state
    }
}
