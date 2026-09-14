package com.callstackincubator.cordierite

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
 * Exercises the public [Cordierite] facade (docs/tasks/19-android-entry-points.md) against a
 * scripted [FakeCordieriteTransport], substituted via [Cordierite.attachForTest] instead of the
 * real [CordieriteInitProvider] path -- no real `Context`, no OkHttp. Complements
 * [CordieriteClientTest], which covers the same session/reconnect behaviors one layer down; this
 * suite only checks that the facade converts to/from [CordieriteClient]'s types correctly.
 * Robolectric-backed (like [CordieriteSpkiPinTest]) because [Cordierite.handle] takes real
 * `android.net.Uri`/`android.content.Intent` values, both stubs that throw "not mocked" on the
 * plain-JVM `android.jar` [CordieriteClientTest] otherwise runs against.
 *
 * [Cordierite] has no public `connect()` of its own (a plain app connects via a delivered
 * bootstrap link, per issue #48's Phase 3 design -- [Cordierite.handle] is the only way in), so
 * [connectAndAck] drives the underlying [CordieriteClient] directly, the same way
 * [CordieriteClientTest] does, rather than adding test-only surface to the public facade.
 */
@RunWith(RobolectricTestRunner::class)
class CordieriteTest {
    private lateinit var client: CordieriteClient
    private lateinit var fake: FakeCordieriteTransport

    @Before
    fun setUp() {
        lateinit var transport: FakeCordieriteTransport
        client =
            CordieriteClient(
                transportFactory = { _, onMessage, onError, onClose ->
                    FakeCordieriteTransport(onMessage, onError, onClose).also { transport = it }
                },
            )
        fake = transport
        Cordierite.attachForTest(client)
    }

    @After
    fun tearDown() {
        Cordierite.detachForTest()
    }

    /** Launches `connect()` on [client] directly, waits for the fake transport to observe the
     * attempt, then acks it. Returns once `connect()` has resolved. */
    private fun connectAndAck(sessionId: String = "sess-1") =
        runBlocking {
            val before = fake.connectCalls.size
            val job =
                kotlinx.coroutines.CoroutineScope(Dispatchers.Default).launch {
                    client.connect(
                        CordieriteConnectInput.Explicit(
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
            Cordierite.register(
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
            Cordierite.register(name = "sum", description = "Adds two numbers.") { args ->
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
            Cordierite.register(name = "slow", description = "Reports progress.") { _, context ->
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
            val registration = Cordierite.register(name = "sum", description = "Adds two numbers.") { _ -> null }
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
    fun `handle(Uri) routes a cordierite bootstrap link into the client`() {
        val bootstrapUri = Uri.parse("cordierite://bootstrap?cordierite=not-a-real-payload")
        assertTrue(Cordierite.handle(bootstrapUri))
    }

    @Test
    fun `handle(Uri) returns false for a URI with no cordierite payload`() {
        val other = Uri.parse("cordierite://bootstrap?nothing=here")
        assertFalse(Cordierite.handle(other))
    }

    @Test
    fun `handle(Intent) reads intent data and returns false for a null data URI`() {
        assertFalse(Cordierite.handle(Intent()))
    }

    // --- listeners / state ---

    @Test
    fun `addListener receives a StateChange once connect acks`() =
        runBlocking {
            val events = mutableListOf<CordieriteEvent>()
            val subscription = Cordierite.addListener { events.add(it) }

            connectAndAck()

            waitUntil {
                events.any { it is CordieriteEvent.StateChange && it.state == ClientState.active }
            }
            subscription.remove()
        }

    @Test
    fun `state and sessionId reflect the underlying client`() =
        runBlocking {
            assertEquals(ClientState.idle, Cordierite.state)
            assertNull(Cordierite.sessionId)

            connectAndAck()

            assertEquals(ClientState.active, Cordierite.state)
            assertEquals("sess-1", Cordierite.sessionId)
        }

    @Test
    fun `buildConfig mirrors the transport's build config`() {
        fake.buildConfigValue = CordieriteBuildConfig(trust = "pin", hasEmbeddedPins = true, allowPrivateLanOnly = true)
        val config = Cordierite.buildConfig
        assertEquals("pin", config.trust)
        assertTrue(config.hasEmbeddedPins)
        assertTrue(config.allowPrivateLanOnly)
    }

    @Test(expected = IllegalStateException::class)
    fun `calling before attach throws a clear error`() {
        Cordierite.detachForTest()
        Cordierite.state
    }
}
