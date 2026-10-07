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
 * Reconnect backoff and grace expiry replayed in virtual time: [AppductClient] runs on a
 * [StandardTestDispatcher] and reads its clock from the same scheduler, so no test waits on the
 * wall clock.
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
    fun `a dropped socket reconnects at the jittered backoff delay and not before`() =
        runTest {
            // First retry: random() * min(cap, 500 ms) = 0.5 * 500 = 250 ms.
            val harness = connected(random = { 0.5 }, graceS = 600.0)
            val connectsBeforeDrop = harness.fake.connectCalls.size

            harness.fake.simulateClose(1006, null)
            runCurrent()
            advanceTimeBy(249)
            runCurrent()
            assertEquals(connectsBeforeDrop, harness.fake.connectCalls.size)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(connectsBeforeDrop + 1, harness.fake.connectCalls.size)
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

    private companion object {
        const val START_MS = 1_800_000_000_000L
    }
}
