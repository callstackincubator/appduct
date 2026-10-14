package com.callstack.appduct

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Grace expiry replayed in virtual time: [AppductClient] runs on a [StandardTestDispatcher] and
 * reads its clock from the same scheduler, so no test waits on the wall clock. Backoff timing is
 * covered by the session scenarios.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AppductClientVirtualTimeTest {
    private class SchedulerClock(private val scheduler: TestCoroutineScheduler) : AppductClock {
        override fun nowMs(): Long = START_MS + scheduler.currentTime
    }

    private class Harness(scheduler: TestCoroutineScheduler, random: () -> Double) {
        lateinit var fake: FakeAppductTransport
        val sessionEvents = CopyOnWriteArrayList<Pair<String, String?>>()
        val client =
            AppductClient(
                transportFactory = { _, onMessage, onError, onClose ->
                    FakeAppductTransport(onMessage, onError, onClose).also { fake = it }
                },
                dispatcher = StandardTestDispatcher(scheduler),
                clock = SchedulerClock(scheduler),
                random = random,
            ).also { it.addSessionChangeListener { type, _, _, reason -> sessionEvents.add(type to reason) } }
    }

    private fun kotlinx.coroutines.test.TestScope.connected(
        random: () -> Double,
        graceS: Double,
    ): Harness {
        val harness = Harness(testScheduler, random)
        launch {
            harness.client.connect(
                AppductConnectInput.Explicit(
                    ip = "127.0.0.1",
                    port = 8443,
                    sessionId = "sess-1",
                    token = "claim-token",
                    resumeToken = null,
                    expiresAt = (START_MS / 1000) + 3600,
                    linkPin = null,
                ),
            )
        }
        runCurrent()
        harness.fake.simulateAck("sess-1", graceS = graceS)
        runCurrent()
        return harness
    }

    @Test
    fun `grace expiry reports the session lost`() =
        runTest {
            val harness = connected(random = { 0.999 }, graceS = 2.0)

            harness.fake.simulateClose(1006, null)
            runCurrent()
            advanceTimeBy(1_999)
            runCurrent()
            assertTrue(harness.sessionEvents.none { it.first == "lost" })

            advanceTimeBy(1)
            runCurrent()
            assertTrue(harness.sessionEvents.contains("lost" to "grace_expired"))
        }

    private fun kotlinx.coroutines.test.TestScope.claiming(
        random: () -> Double,
        firstConnectFails: Throwable,
        closeToo: Boolean = false,
    ): Harness {
        val harness = Harness(testScheduler, random)
        harness.fake.failNextConnectOnce = firstConnectFails
        harness.fake.closeAfterFailedConnect = closeToo
        launch {
            runCatching {
                harness.client.connect(
                    AppductConnectInput.Explicit(
                        ip = "127.0.0.1",
                        port = 8443,
                        sessionId = "sess-1",
                        token = "claim-token",
                        resumeToken = null,
                        expiresAt = (START_MS / 1000) + 3600,
                        linkPin = null,
                    ),
                )
            }
        }
        runCurrent()
        return harness
    }

    @Test
    fun `a claim whose connect failed keeps waiting out its backoff when the socket's close event arrives late`() =
        runTest {
            val harness = claiming(random = { 0.5 }, firstConnectFails = java.io.IOException("Failed to connect to /127.0.0.1:8443"))
            assertEquals(AppductClientState.connecting, harness.client.state)

            harness.fake.simulateClose(null, null)
            runCurrent()
            assertEquals(AppductClientState.connecting, harness.client.state)

            advanceTimeBy(250)
            runCurrent()
            assertEquals(2, harness.fake.connectCalls.size)
            harness.fake.simulateAck("sess-1")
            runCurrent()
            assertEquals(AppductClientState.active, harness.client.state)
        }

    @Test
    fun `a claim whose connect failed waits for its socket's close event before it retries`() =
        runTest {
            val harness = claiming(random = { 0.5 }, firstConnectFails = java.io.IOException("Failed to connect to /127.0.0.1:8443"))

            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, harness.fake.connectCalls.size)

            harness.fake.simulateClose(null, null)
            runCurrent()
            advanceTimeBy(250)
            runCurrent()
            assertEquals(2, harness.fake.connectCalls.size)
            harness.fake.simulateAck("sess-1")
            runCurrent()
            assertEquals(AppductClientState.active, harness.client.state)
        }

    @Test
    fun `a claim with no backoff is not settled by the late close event of the socket that failed`() =
        runTest {
            val harness = claiming(random = { 0.0 }, firstConnectFails = java.io.IOException("Failed to connect to /127.0.0.1:8443"), closeToo = true)

            runCurrent()
            assertEquals(2, harness.fake.connectCalls.size)
            harness.fake.simulateAck("sess-1")
            runCurrent()
            assertEquals(AppductClientState.active, harness.client.state)
        }

    @Test
    fun `a claim does not retry a connect that failed on a pin mismatch`() =
        runTest {
            val mismatch =
                javax.net.ssl.SSLHandshakeException("Chain validation failed").apply {
                    initCause(java.security.cert.CertificateException("Server certificate pin mismatch."))
                }
            val harness = claiming(random = { 0.5 }, firstConnectFails = mismatch, closeToo = true)

            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, harness.fake.connectCalls.size)
            assertEquals(AppductClientState.closed, harness.client.state)
        }

    @Test
    fun `a claim does not retry a connect that was refused as misconfigured`() =
        runTest {
            val harness = claiming(random = { 0.5 }, firstConnectFails = IllegalArgumentException("Appduct only allows local IPv4 addresses."))

            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, harness.fake.connectCalls.size)
            assertEquals(AppductClientState.closed, harness.client.state)
        }

    private companion object {
        const val START_MS = 1_800_000_000_000L
    }
}
