package com.callstack.appduct

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A warm link supersedes the live session: the client closes the transport and connects again at
 * once. `close()` therefore has to finish tearing down before it reports back, or the new
 * `connect()` is rejected as "already connecting or active" (#234).
 *
 * Robolectric supplies the application context the real manager reads its manifest config from.
 * The "server" is a socket that accepts TCP but never answers the TLS handshake, which keeps
 * every connect pending.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AppductConnectionManagerCloseTest {
    @Before
    fun resetLeaseStore() {
        AppductProcessResumeLeaseStore.resetForTests()
    }

    @Test
    fun `close while connecting leaves the manager closed and accepts a new connect`() {
        ServerSocket(0, 10, InetAddress.getByName("127.0.0.1")).use { silentServer ->
            val closeEvents = CopyOnWriteArrayList<Map<String, Any?>>()
            val manager = newManager(closeEvents)
            val options = connectOptions(silentServer.localPort)

            manager.connect(options) {}
            waitUntil("the first connect is in flight") { manager.getState() == "connecting" }

            val closed = CountDownLatch(1)
            manager.close { closed.countDown() }
            assertTrue(closed.await(2, TimeUnit.SECONDS))
            assertEquals("closed", manager.getState())

            val secondConnectOutcome = CopyOnWriteArrayList<Throwable?>()
            manager.connect(options) { secondConnectOutcome.add(it) }
            waitUntil("the second connect was accepted") { manager.getState() == "connecting" }
            assertEquals(emptyList<Throwable?>(), secondConnectOutcome)

            val invalidated = CountDownLatch(1)
            manager.invalidate { invalidated.countDown() }
            assertTrue(invalidated.await(2, TimeUnit.SECONDS))
        }
    }

    @Test
    fun `close does not emit a close event for the socket it dropped`() {
        ServerSocket(0, 10, InetAddress.getByName("127.0.0.1")).use { silentServer ->
            val closeEvents = CopyOnWriteArrayList<Map<String, Any?>>()
            val manager = newManager(closeEvents)

            manager.connect(connectOptions(silentServer.localPort)) {}
            waitUntil("the connect is in flight") { manager.getState() == "connecting" }

            val closed = CountDownLatch(1)
            manager.close { closed.countDown() }
            assertTrue(closed.await(2, TimeUnit.SECONDS))
            Thread.sleep(300)

            assertEquals(emptyList<Map<String, Any?>>(), closeEvents.toList())
            assertEquals("closed", manager.getState())

            val invalidated = CountDownLatch(1)
            manager.invalidate { invalidated.countDown() }
            assertTrue(invalidated.await(2, TimeUnit.SECONDS))
        }
    }

    private fun newManager(closeEvents: MutableList<Map<String, Any?>>) =
        AppductConnectionManager(
            context = RuntimeEnvironment.getApplication(),
            emitStateChange = {},
            emitMessageRaw = {},
            emitError = {},
            emitClose = { closeEvents.add(it) },
        )

    private fun connectOptions(port: Int): Map<String, Any?> =
        mapOf(
            "ip" to "127.0.0.1",
            "port" to port,
            "sessionId" to "session-1",
            "token" to "claim-token",
            "expiresAt" to Int.MAX_VALUE,
            "linkPin" to "sha256/link-pin",
        )

    private fun waitUntil(
        what: String,
        condition: () -> Boolean,
    ) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(5)
        }
        throw AssertionError("Timed out waiting for: $what")
    }
}
