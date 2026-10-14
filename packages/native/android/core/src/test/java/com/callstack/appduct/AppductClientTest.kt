package com.callstack.appduct

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Port of the behaviors `client.test.ts`/`tool-invocation.test.ts`/`bootstrap.test.ts`/
 * `deep-link-bootstrap.test.ts` describe for the JS client, exercised here against
 * [AppductClient] over a [FakeAppductTransport]. Real reconnect/backoff/grace timing (which
 * would need seconds of wall-clock time per test) is out of scope here; `AppductClientVirtualTimeTest`
 * replays it on a test dispatcher and clock. The backoff math and close-code classification it is
 * built from are covered directly by `AppductBackoffTest` and `AppductTerminalCloseTest`.
 */
class AppductClientTest {
    private fun newClient(
        lifecycleObserverFactory: (onBackgroundedChanged: (Boolean) -> Unit) -> AppductAppLifecycleObserver =
            { AppductNoopLifecycleObserver() },
    ): Pair<AppductClient, FakeAppductTransport> {
        lateinit var fake: FakeAppductTransport
        val client =
            AppductClient(
                transportFactory = { _, onMessage, onError, onClose ->
                    FakeAppductTransport(onMessage, onError, onClose).also { fake = it }
                },
                lifecycleObserverFactory = lifecycleObserverFactory,
            )
        return client to fake
    }

    /** Waits for a `tool_error` frame among [FakeAppductTransport.sentMessages] and returns it --
     * `registerTool`'s own `tool_registry_delta` send races the tool-call reply, so the first sent
     * message is not reliably the one under test. */
    private fun FakeAppductTransport.awaitToolError(timeoutMs: Long = 2000): JSONObject {
        waitUntil(timeoutMs) { sentMessages.any { JSONObject(it).optString("type") == "tool_error" } }
        return sentMessages.map { JSONObject(it) }.first { it.getString("type") == "tool_error" }
    }

    private fun explicitInput(
        sessionId: String = "sess-1",
        token: String? = "claim-token",
        resumeToken: String? = null,
        expiresAt: Long = Long.MAX_VALUE / 2,
        linkPin: String? = null,
    ) = AppductConnectInput.Explicit(
        ip = "127.0.0.1",
        port = 8443,
        sessionId = sessionId,
        token = token,
        resumeToken = resumeToken,
        expiresAt = expiresAt,
        linkPin = linkPin,
    )

    /** Launches `connect()`, waits for the fake transport to observe the attempt, then acks it.
     * Returns once `connect()` has resolved. */
    private fun AppductClient.connectAndAck(
        fake: FakeAppductTransport,
        sessionId: String = "sess-1",
        graceS: Double = 600.0,
        linkPin: String? = null,
    ) = runBlocking {
        val before = fake.connectCalls.size
        val job = launch(Dispatchers.Default) { connect(explicitInput(sessionId = sessionId, linkPin = linkPin)) }
        waitUntil { fake.connectCalls.size > before }
        fake.simulateAck(sessionId, graceS = graceS)
        job.join()
    }

    /** Captures one call of [AppductSessionChangeListener]'s 4-arg callback shape. */
    private data class SessionChangeEvent(
        val type: String,
        val sessionId: String?,
        val alias: String?,
        val reason: String?,
    )

    // --- connect / handshake ---

    @Test
    fun `connect resolves and moves to active once session_ack arrives`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake, sessionId = "sess-1")

            assertEquals(AppductClientState.active, client.state)
            assertEquals("sess-1", client.sessionId)
        }

    @Test
    fun `connect sends a tool_registry_snapshot right after the ack`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)

            waitUntil { fake.sentMessages.isNotEmpty() }
            val snapshot = JSONObject(fake.sentMessages.first())
            assertEquals("tool_registry_snapshot", snapshot.getString("type"))
            assertEquals(0, snapshot.getJSONArray("tools").length())
        }

    @Test
    fun `connect rejects an already-expired payload without touching the transport`() =
        runBlocking {
            val (client, fake) = newClient()
            assertThrows(IllegalArgumentException::class.java) {
                runBlocking { client.connect(explicitInput(expiresAt = 0)) }
            }
            assertEquals(0, fake.connectCalls.size)
        }

    @Test
    fun `connect rejects when a session is already connecting without supersede`() =
        runBlocking {
            val (client, fake) = newClient()
            val before = fake.connectCalls.size
            val firstConnect = launch(Dispatchers.Default) { client.connect(explicitInput(sessionId = "sess-1")) }
            waitUntil { fake.connectCalls.size > before }

            assertThrows(IllegalStateException::class.java) {
                runBlocking { client.connect(explicitInput(sessionId = "sess-2")) }
            }

            fake.simulateAck("sess-1")
            firstConnect.join()
        }

    @Test
    fun `supersede replaces a connecting session with a new one`() =
        runBlocking {
            val (client, fake) = newClient()
            val before = fake.connectCalls.size
            // Expected to fail with "superseded by a fresh connection" once the second connect()
            // below supersedes it -- not a test failure.
            val firstConnect =
                launch(Dispatchers.Default) {
                    try {
                        client.connect(explicitInput(sessionId = "sess-1"))
                    } catch (_: Exception) {
                    }
                }
            waitUntil { fake.connectCalls.size > before }

            val secondBefore = fake.connectCalls.size
            val secondConnect = launch(Dispatchers.Default) { client.connect(explicitInput(sessionId = "sess-2"), supersede = true) }
            waitUntil { fake.connectCalls.size > secondBefore }
            fake.simulateAck("sess-2")
            secondConnect.join()
            firstConnect.join()

            assertEquals("sess-2", client.sessionId)
            assertEquals(AppductClientState.active, client.state)
        }

    @Test
    fun `a connect that fails after a superseding connect does not fail the new one`() =
        runBlocking {
            val (client, fake) = newClient()
            fake.holdNextConnect = true
            // Expected to fail once the second connect() below supersedes it -- not a test failure.
            val firstConnect =
                launch(Dispatchers.Default) {
                    try {
                        client.connect(explicitInput(sessionId = "sess-1"))
                    } catch (_: Exception) {
                    }
                }
            waitUntil { fake.hasHeldConnect }

            val secondConnect = async(Dispatchers.Default) { runCatching { client.connect(explicitInput(sessionId = "sess-2"), supersede = true) } }
            waitUntil { fake.connectCalls.size >= 2 }
            fake.failHeldConnect(IllegalStateException("Appduct connection was closed before it finished connecting."))
            Thread.sleep(150)
            fake.simulateAck("sess-2")

            assertTrue(secondConnect.await().isSuccess)
            firstConnect.join()
            assertEquals("sess-2", client.sessionId)
        }

    @Test
    fun `a superseding connect aborts the old session's in-flight tool handler`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            val started = CompletableDeferred<Unit>()
            val aborted = CompletableDeferred<Unit>()
            client.registerTool(AppductToolDescriptor(name = "slow", description = "Never finishes.")) { _, _ ->
                started.complete(Unit)
                try {
                    kotlinx.coroutines.delay(60_000)
                } finally {
                    aborted.complete(Unit)
                }
                null
            }
            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "slow").put(
                    "args",
                    JSONObject(),
                ),
            )
            started.await()

            val secondConnect = launch(Dispatchers.Default) { client.connect(explicitInput(sessionId = "sess-2"), supersede = true) }

            withTimeout(2_000) { aborted.await() }
            waitUntil { fake.connectCalls.size >= 2 }
            fake.simulateAck("sess-2")
            secondConnect.join()
        }

    // --- registerTool / unregisterTool ---

    @Test
    fun `registerTool throws for an invalid descriptor`() {
        val (client, _) = newClient()
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            client.registerTool(AppductToolDescriptor(name = "bad name", description = "x")) { _, _ -> null }
        }
    }

    @Test
    fun `registerTool upsert by name is reflected in registeredTools`() {
        val (client, _) = newClient()
        client.registerTool(AppductToolDescriptor(name = "sum", description = "Add.")) { _, _ -> null }
        client.registerTool(AppductToolDescriptor(name = "sum", description = "Add two numbers.")) { _, _ -> null }

        assertEquals(1, client.registeredTools.size)
        assertEquals("Add two numbers.", client.registeredTools.first().description)
    }

    @Test
    fun `registerTool sends a delta while active`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            fake.sentMessages.clear()

            client.registerTool(AppductToolDescriptor(name = "sum", description = "Add.")) { _, _ -> null }

            waitUntil { fake.sentMessages.isNotEmpty() }
            val delta = JSONObject(fake.sentMessages.first())
            assertEquals("tool_registry_delta", delta.getString("type"))
            assertEquals("upsert", delta.getString("operation"))
            assertEquals("sum", delta.getJSONObject("tool").getString("name"))
        }

    // --- tool invocation ---

    @Test
    fun `an unknown tool call replies tool_not_found`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "missing").put(
                    "args",
                    JSONObject(),
                ),
            )

            waitUntil { fake.sentMessages.isNotEmpty() }
            val error = JSONObject(fake.sentMessages.first())
            assertEquals("tool_error", error.getString("type"))
            assertEquals("tool_not_found", error.getJSONObject("error").getString("type"))
        }

    @Test
    fun `a registered tool call replies tool_result`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            client.registerTool(AppductToolDescriptor(name = "sum", description = "Add.")) { args, _ ->
                mapOf("total" to args.getInt("a") + args.getInt("b"))
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject()
                    .put("type", "tool_call")
                    .put("session_id", "sess-1")
                    .put("id", "call-1")
                    .put("name", "sum")
                    .put("args", JSONObject().put("a", 2).put("b", 3)),
            )

            waitUntil { fake.sentMessages.any { JSONObject(it).optString("type") == "tool_result" } }
            val result = fake.sentMessages.map { JSONObject(it) }.first { it.getString("type") == "tool_result" }
            assertEquals(5, result.getJSONObject("result").getInt("total"))
        }

    @Test
    fun `a thrown handler error replies tool_execution_error`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            client.registerTool(AppductToolDescriptor(name = "boom", description = "Throws.")) { _, _ ->
                throw RuntimeException("kaboom")
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "boom").put(
                    "args",
                    JSONObject(),
                ),
            )

            val error = fake.awaitToolError()
            assertEquals("tool_execution_error", error.getJSONObject("error").getString("type"))
            assertEquals("kaboom", error.getJSONObject("error").getString("message"))
        }

    @Test
    fun `a thrown handler error over the frame limit replies tool_serialization_error`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            client.registerTool(AppductToolDescriptor(name = "boom", description = "Throws.")) { _, _ ->
                throw RuntimeException("x".repeat(300_000))
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "boom").put(
                    "args",
                    JSONObject(),
                ),
            )

            val error = fake.awaitToolError().getJSONObject("error")
            assertEquals("tool_serialization_error", error.getString("type"))
            assertTrue(Regex("^Appduct frame is \\d+ bytes, over the 262144-byte limit\\.$").matches(error.getString("message")))
            assertFalse(error.has("details"))
            assertEquals(AppductClientState.active, client.state)
        }

    @Test
    fun `an unserializable result replies tool_serialization_error`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            client.registerTool(AppductToolDescriptor(name = "weird", description = "Bad result.")) { _, _ ->
                object : Any() {}
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "weird").put(
                    "args",
                    JSONObject(),
                ),
            )

            val error = fake.awaitToolError()
            assertEquals("tool_serialization_error", error.getJSONObject("error").getString("type"))
        }

    @Test
    fun `tool_cancel aborts the in-flight handler and replies tool_cancelled`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            val started = CompletableDeferred<Unit>()
            client.registerTool(AppductToolDescriptor(name = "slow", description = "Never finishes.")) { _, _ ->
                started.complete(Unit)
                kotlinx.coroutines.delay(60_000)
                null
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "slow").put(
                    "args",
                    JSONObject(),
                ),
            )
            started.await()

            fake.simulateMessage(
                JSONObject().put("type", "tool_cancel").put("session_id", "sess-1").put("id", "call-1").put("reason", "client_cancelled"),
            )

            val error = fake.awaitToolError()
            assertEquals("tool_cancelled", error.getJSONObject("error").getString("type"))
        }

    @Test
    fun `tool_cancel's tool_cancelled reply completes cleanly even when the reply send itself genuinely suspends`() =
        runBlocking {
            // Regression test (issue #48 review): handleToolCancel cancels the handler's own Job, so
            // by the time the catch(CancellationException) block's own sendToolError call suspends
            // through rawSend's suspendCancellableCoroutine, the coroutine is already "Cancelling" --
            // an ordinary suspension point in that state resumes with a JobCancellationException
            // instead of the outcome the send actually completed with, which sendSafely's
            // catch (Throwable) then silently turns into a spurious phase="tool" error, even though
            // the tool_cancelled frame itself still reaches sentMessages (the underlying executor
            // dispatch that writes it runs to completion regardless of the awaiting coroutine's own
            // fate). The fix wraps that send in withContext(NonCancellable) { ... }, so the coroutine
            // observes the send's real (successful) outcome instead of a forced cancellation.
            //
            // FakeAppductTransport's default synchronous completion resumes the continuation
            // inline, before suspendCancellableCoroutine ever truly suspends -- which cannot
            // reproduce the bug (the coroutine dispatcher/cancellation machinery is never consulted
            // at all). deferSendCompletion forces a genuine suspend-then-resume-via-dispatcher, the
            // same shape a real socket write has.
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            val errors = CopyOnWriteArrayList<AppductUnifiedError>()
            client.addErrorListener { errors.add(it) }
            val started = CompletableDeferred<Unit>()
            client.registerTool(AppductToolDescriptor(name = "slow", description = "Never finishes.")) { _, _ ->
                started.complete(Unit)
                kotlinx.coroutines.delay(60_000)
                null
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "slow").put(
                    "args",
                    JSONObject(),
                ),
            )
            started.await()

            fake.deferSendCompletion = true
            fake.simulateMessage(
                JSONObject().put("type", "tool_cancel").put("session_id", "sess-1").put("id", "call-1").put("reason", "client_cancelled"),
            )

            val error = fake.awaitToolError()
            assertEquals("tool_cancelled", error.getJSONObject("error").getString("type"))

            // Give the deferred completion (20ms) time to settle, then assert it was not turned into
            // a spurious send-failure report -- the actual bug signature this test guards against.
            waitUntil(timeoutMs = 500) { true }
            assertTrue("expected no spurious tool-phase error, got: $errors", errors.none { it.phase == "tool" })
        }

    @Test
    fun `a slow tool times out on its declared timeoutMs`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            // APPDUCT_MIN_TOOL_TIMEOUT_MS, not an arbitrarily small value: registerTool clamps a
            // declared timeoutMs to [APPDUCT_MIN_TOOL_TIMEOUT_MS, APPDUCT_MAX_TOOL_TIMEOUT_MS]
            // (AppductToolRegistryTest covers the clamp itself), so a smaller value would still
            // time out correctly here but at the clamped floor instead of the declared one.
            client.registerTool(
                AppductToolDescriptor(name = "slow", description = "Too slow.", timeoutMs = APPDUCT_MIN_TOOL_TIMEOUT_MS),
            ) { _, _ ->
                kotlinx.coroutines.delay(60_000)
                null
            }
            fake.sentMessages.clear()

            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "slow").put(
                    "args",
                    JSONObject(),
                ),
            )

            // APPDUCT_MIN_TOOL_TIMEOUT_MS (1s) needs more real-time slack than the 2s default.
            val error = fake.awaitToolError(timeoutMs = 5_000)
            assertEquals("tool_timeout", error.getJSONObject("error").getString("type"))
        }

    // --- handleUrl ---

    @Test
    fun `handleUrl returns false for a URL with no appduct param`() {
        val (client, _) = newClient()
        assertEquals(false, client.handleUrl("myapp:///open"))
    }

    @Test
    fun `handleUrl returns true and reports a bootstrap error for a malformed payload`() =
        runBlocking {
            val (client, _) = newClient()
            val errors = CopyOnWriteArrayList<AppductUnifiedError>()
            client.addErrorListener { errors.add(it) }

            assertEquals(true, client.handleUrl("myapp:///?appduct=not-valid-base64"))

            waitUntil { errors.isNotEmpty() }
            assertEquals("bootstrap", errors.first().phase)
        }

    // --- listeners ---

    @Test
    fun `sessionChange fires claimed, then lost reason revoked with both fields null, on a 1000 close`() =
        runBlocking {
            val (client, fake) = newClient()
            val events = CopyOnWriteArrayList<SessionChangeEvent>()
            client.addSessionChangeListener { type, sessionId, alias, reason ->
                events.add(SessionChangeEvent(type, sessionId, alias, reason))
            }

            client.connectAndAck(fake, sessionId = "sess-1")
            waitUntil { events.isNotEmpty() }
            assertEquals(SessionChangeEvent("claimed", "sess-1", "test-device", null), events.first())

            fake.simulateClose(1000, "revoked")
            waitUntil { events.size >= 2 }
            assertEquals(SessionChangeEvent("lost", null, null, "revoked"), events[1])
            assertEquals(AppductClientState.closed, client.state)
        }

    @Test
    fun `sessionChange fires resumed with no reason after a successful reconnect`() =
        runBlocking {
            val (client, fake) = newClient()
            val events = CopyOnWriteArrayList<SessionChangeEvent>()
            client.addSessionChangeListener { type, sessionId, alias, reason ->
                events.add(SessionChangeEvent(type, sessionId, alias, reason))
            }

            // A long grace window so only the reconnect (not the grace timer) resolves first.
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0)
            waitUntil { events.isNotEmpty() }
            assertEquals("claimed", events.first().type)

            val connectCallsBeforeReconnect = fake.connectCalls.size
            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectCallsBeforeReconnect }
            fake.simulateAck("sess-1", graceS = 120.0)

            waitUntil(timeoutMs = 3_000) { events.size >= 2 }
            assertEquals(SessionChangeEvent("resumed", "sess-1", "test-device", null), events[1])
        }

    // --- link pin carried across a resume (issue #136) ---

    /** A build that trusts the link's pin (`trust: link`, no embedded pins) has nowhere else to
     * get one for a resume -- the transport rejects the connect outright unless the pin the
     * original claim trusted rides along. This is the red test the issue's root cause was
     * confirmed with. */
    @Test
    fun `a resume after a socket loss carries the original link pin`() =
        runBlocking {
            val (client, fake) = newClient()
            val pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0, linkPin = pin)

            val connectCallsBeforeReconnect = fake.connectCalls.size
            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectCallsBeforeReconnect }

            assertEquals(pin, fake.connectCalls.last()["linkPin"])
        }

    /** A resume ack rotates the resume token; the pin has to survive that, or only the first
     * resume of a session ever works. */
    @Test
    fun `a second resume still carries the original link pin`() =
        runBlocking {
            val (client, fake) = newClient()
            val pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0, linkPin = pin)

            val connectCallsBeforeFirstResume = fake.connectCalls.size
            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectCallsBeforeFirstResume }
            fake.simulateAck("sess-1", graceS = 120.0)
            waitUntil(timeoutMs = 3_000) { client.state == AppductClientState.active }

            val connectCallsBeforeSecondResume = fake.connectCalls.size
            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectCallsBeforeSecondResume }

            assertEquals(pin, fake.connectCalls.last()["linkPin"])
        }

    /** Control for the fix above: a build with embedded pins never carried a link pin in the
     * first place, so a resume must keep connecting with no `linkPin`, exactly as before. */
    @Test
    fun `a resume with no link pin stays pinless`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0)

            val connectCallsBeforeReconnect = fake.connectCalls.size
            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectCallsBeforeReconnect }

            assertNull(fake.connectCalls.last()["linkPin"])
        }

    /** Returning to the foreground while `reconnecting` fires an immediate resume attempt
     * (`onBackgroundedChanged`) -- that attempt must carry the original link pin exactly like a
     * backoff-timer-driven one does, using a fake lifecycle observer the test can flip on demand
     * rather than a real `ProcessLifecycleOwner`. */
    @Test
    fun `returning to the foreground resumes with the original link pin`() =
        runBlocking {
            lateinit var lifecycle: FakeAppductLifecycleObserver
            val (client, fake) =
                newClient(
                    lifecycleObserverFactory = { onChanged ->
                        FakeAppductLifecycleObserver(onChanged).also { lifecycle = it }
                    },
                )
            val pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0, linkPin = pin)

            // Background the app first: no reconnect timer fires while backgrounded, so the only
            // thing that can trigger the resume below is the foreground transition itself.
            lifecycle.simulateForegroundChange(background = true)
            val connectCallsBeforeReconnect = fake.connectCalls.size
            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { client.state == AppductClientState.reconnecting }
            Thread.sleep(50)
            assertEquals(connectCallsBeforeReconnect, fake.connectCalls.size)

            lifecycle.simulateForegroundChange(background = false)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size > connectCallsBeforeReconnect }

            assertEquals(pin, fake.connectCalls.last()["linkPin"])
        }

    // --- background close (issue #138) ---

    private fun newBackgroundableClient(): Triple<AppductClient, FakeAppductTransport, () -> FakeAppductLifecycleObserver> {
        lateinit var lifecycle: FakeAppductLifecycleObserver
        val (client, fake) =
            newClient(
                lifecycleObserverFactory = { onChanged -> FakeAppductLifecycleObserver(onChanged).also { lifecycle = it } },
            )
        return Triple(client, fake) { lifecycle }
    }

    @Test
    fun `backgrounding an active session closes for the background, keeps the lease and schedules no reconnect`() =
        runBlocking {
            val (client, fake, lifecycle) = newBackgroundableClient()
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0)

            lifecycle().simulateForegroundChange(background = true)
            waitUntil(timeoutMs = 3_000) { fake.closeForBackgroundCalls.get() == 1 }
            waitUntil(timeoutMs = 3_000) { client.state == AppductClientState.reconnecting }

            // `close()` would clear the resume lease; the session must stay resumable.
            assertEquals(0, fake.closeCalls.get())
            Thread.sleep(1_500)
            assertEquals(1, fake.connectCalls.size)
        }

    @Test
    fun `backgrounding an active session emits no error event`() =
        runBlocking {
            val (client, fake, lifecycle) = newBackgroundableClient()
            val errors = CopyOnWriteArrayList<AppductUnifiedError>()
            client.addErrorListener { errors.add(it) }
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0)

            lifecycle().simulateForegroundChange(background = true)
            waitUntil(timeoutMs = 3_000) { client.state == AppductClientState.reconnecting }

            assertTrue("expected no error, got: $errors", errors.isEmpty())
        }

    @Test
    fun `foregrounding after a background close resumes the session`() =
        runBlocking {
            val (client, fake, lifecycle) = newBackgroundableClient()
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0)

            lifecycle().simulateForegroundChange(background = true)
            waitUntil(timeoutMs = 3_000) { client.state == AppductClientState.reconnecting }

            lifecycle().simulateForegroundChange(background = false)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.size == 2 }
            assertEquals("resume-token-sess-1", fake.connectCalls.last()["resumeToken"])
            fake.simulateAck("sess-1", resumeToken = "resume-token-2")
            waitUntil(timeoutMs = 3_000) { client.state == AppductClientState.active }
        }

    @Test
    fun `backgrounding without an active session does not close the socket`() =
        runBlocking {
            val (_, fake, lifecycle) = newBackgroundableClient()

            lifecycle().simulateForegroundChange(background = true)
            Thread.sleep(100)

            assertEquals(0, fake.closeForBackgroundCalls.get())
        }

    /** A failed resume attempt no longer reports a bare "Appduct resume attempt failed." -- the
     * underlying cause (here, the transport's own rejection) rides along in the message. */
    @Test
    fun `a failed resume attempt reports its underlying cause`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 120.0)

            val errorMessages = CopyOnWriteArrayList<String>()
            client.addErrorListener { error -> errorMessages.add(error.message) }

            fake.nextConnectError = IllegalStateException("boom: no pin to trust")
            fake.simulateClose(1006, null)

            waitUntil(timeoutMs = 3_000) { errorMessages.any { it.contains("boom: no pin to trust") } }
        }

    // --- restoreSession (issue #136) ---

    /** A lease written by a pinned claim must resume with that same pin after a JS reload
     * -- `restoreSession` has no claim/deep-link to read a pin from, only the lease, so the lease
     * itself has to carry it. */
    @Test
    fun `restoreSession from a lease written by a pinned claim resumes with that pin`() =
        runBlocking {
            val (client, fake) = newClient()
            val pin = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            fake.resumeLeaseRecordValue =
                AppductResumeLeaseV1(
                    sessionId = "sess-restored",
                    resumeToken = "resume-token",
                    alias = "iphone-1",
                    endpoint = AppductResumeEndpoint("127.0.0.1", 8443),
                    keepaliveIntervalS = 30.0,
                    graceS = 120.0,
                    disconnectedAtMs = null,
                    linkPin = pin,
                ).toRecord()

            val restored = client.restoreSession()
            assertTrue(restored)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.isNotEmpty() }

            assertEquals(pin, fake.connectCalls.last()["linkPin"])
        }

    /** Control for the fix above: a lease from a build with embedded pins carries no link pin,
     * so `restoreSession` must keep resuming with no `linkPin`, exactly as before. */
    @Test
    fun `restoreSession from an unpinned lease stays pinless`() =
        runBlocking {
            val (client, fake) = newClient()
            fake.resumeLeaseRecordValue =
                AppductResumeLeaseV1(
                    sessionId = "sess-restored",
                    resumeToken = "resume-token",
                    alias = "iphone-1",
                    endpoint = AppductResumeEndpoint("127.0.0.1", 8443),
                    keepaliveIntervalS = 30.0,
                    graceS = 120.0,
                    disconnectedAtMs = null,
                ).toRecord()

            val restored = client.restoreSession()
            assertTrue(restored)
            waitUntil(timeoutMs = 3_000) { fake.connectCalls.isNotEmpty() }

            assertNull(fake.connectCalls.last()["linkPin"])
        }

    @Test
    fun `sessionChange fires lost reason grace_expired once the grace window elapses`() =
        runBlocking {
            val (client, fake) = newClient()
            val events = CopyOnWriteArrayList<SessionChangeEvent>()
            client.addSessionChangeListener { type, sessionId, alias, reason ->
                events.add(SessionChangeEvent(type, sessionId, alias, reason))
            }

            // A tiny grace window so the grace timer, not the reconnect backoff, resolves first.
            client.connectAndAck(fake, sessionId = "sess-1", graceS = 0.05)
            waitUntil { events.isNotEmpty() }

            fake.simulateClose(1006, null)
            waitUntil(timeoutMs = 3_000) { events.size >= 2 }

            assertEquals(SessionChangeEvent("lost", null, null, "grace_expired"), events[1])
        }

    @Test
    fun `a terminal 1008 close finalizes the session as lost with the daemon's reason`() =
        runBlocking {
            val (client, fake) = newClient()
            val events = CopyOnWriteArrayList<SessionChangeEvent>()
            client.addSessionChangeListener { type, sessionId, alias, reason ->
                events.add(SessionChangeEvent(type, sessionId, alias, reason))
            }
            client.connectAndAck(fake, sessionId = "sess-1")

            fake.simulateClose(1008, "unknown_session")

            waitUntil { client.state == AppductClientState.closed }
            assertNull(client.sessionId)
            assertEquals(SessionChangeEvent("lost", null, null, "unknown_session"), events.last())
        }

    // --- disconnect / postEvent ---

    @Test
    fun `disconnect aborts an in-flight tool handler`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            val started = CompletableDeferred<Unit>()
            val aborted = CompletableDeferred<Unit>()
            client.registerTool(AppductToolDescriptor(name = "slow", description = "Never finishes.")) { _, _ ->
                started.complete(Unit)
                try {
                    kotlinx.coroutines.delay(60_000)
                } finally {
                    aborted.complete(Unit)
                }
                null
            }
            fake.simulateMessage(
                JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", "call-1").put("name", "slow").put(
                    "args",
                    JSONObject(),
                ),
            )
            started.await()

            client.disconnect()

            withTimeout(2_000) { aborted.await() }
        }

    @Test
    fun `disconnect closes the transport, moves to closed, and fires sessionChange lost reason closed_by_app`() =
        runBlocking {
            val (client, fake) = newClient()
            val events = CopyOnWriteArrayList<SessionChangeEvent>()
            client.connectAndAck(fake)
            client.addSessionChangeListener { type, sessionId, alias, reason ->
                events.add(SessionChangeEvent(type, sessionId, alias, reason))
            }

            client.disconnect()

            assertEquals(AppductClientState.closed, client.state)
            assertEquals("closed", fake.rawState)
            assertEquals(SessionChangeEvent("lost", null, null, "closed_by_app"), events.last())
        }

    @Test
    fun `postEvent is a no-op when no session is active`() =
        runBlocking {
            val (client, fake) = newClient()
            client.postEvent("screen_changed", null)
            assertEquals(0, fake.sentMessages.size)
        }

    @Test
    fun `postEvent sends an event frame with session_id and ts`() =
        runBlocking {
            val (client, fake) = newClient()
            client.connectAndAck(fake)
            fake.sentMessages.clear()

            client.postEvent("screen_changed", mapOf("screen" to "Checkout"))

            assertEquals(1, fake.sentMessages.size)
            val event = JSONObject(fake.sentMessages.first())
            assertEquals("event", event.getString("type"))
            assertEquals("screen_changed", event.getString("name"))
            assertEquals("Checkout", event.getJSONObject("payload").getString("screen"))
            assertNotNull(event.opt("ts"))
        }

    @Test
    fun `a tool registry snapshot over the frame limit goes to the error listener and keeps the session active`() =
        runBlocking {
            val (client, fake) = newClient()
            val errors = CopyOnWriteArrayList<AppductUnifiedError>()
            client.addErrorListener { errors.add(it) }
            for (i in 0 until 70) {
                client.registerTool(AppductToolDescriptor(name = "tool_$i", description = "x".repeat(4096))) { _, _ -> null }
            }

            client.connectAndAck(fake)

            waitUntil { errors.isNotEmpty() }
            assertTrue(fake.sentMessages.none { JSONObject(it).optString("type") == "tool_registry_snapshot" })
            assertEquals("tool", errors.first().phase)
            assertTrue(Regex("^Appduct frame is \\d+ bytes, over the 262144-byte limit\\.$").matches(errors.first().message))
            assertEquals(AppductClientState.active, client.state)
        }
}
