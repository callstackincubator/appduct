package dev.appduct

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val LINK = "myapp:///?appduct=AAAA&pin=sha256/x"
private val DEVICE = ShimDevice(manufacturer = "Google", model = "Pixel 9", os = "Android 16")

class ShimStateTest {
    private val received = mutableListOf<String>()
    private val engineA = Any()
    private val engineB = Any()

    private fun ShimState.activateA() = activate(engineA, DEVICE) { received += it }

    @Test
    fun `the first activate owns the shim and returns the device`() {
        val result = ShimState().activateA()

        assertEquals(
            mapOf(
                "owner" to true,
                "links" to emptyList<String>(),
                "lease" to null,
                "device" to mapOf("manufacturer" to "Google", "model" to "Pixel 9", "os" to "Android 16"),
            ),
            result,
        )
    }

    @Test
    fun `a second engine gets owner false and nothing else`() {
        val state = ShimState()
        state.activateA()

        assertEquals(mapOf("owner" to false), state.activate(engineB, DEVICE) {})
    }

    @Test
    fun `the owner activating again after a hot restart is still the owner`() {
        val state = ShimState()
        state.activateA()
        state.writeLease(engineA, "lease-1")

        val again = state.activateA()

        assertEquals(true, again["owner"])
        assertEquals("lease-1", again["lease"])
    }

    @Test
    fun `a lease survives the engine being detached and a new engine activating`() {
        val state = ShimState()
        state.activateA()
        state.writeLease(engineA, "lease-1")
        state.release(engineA)

        val result = state.activate(engineB, DEVICE) {}

        assertEquals(true, result["owner"])
        assertEquals("lease-1", result["lease"])
    }

    @Test
    fun `clearLease removes the lease`() {
        val state = ShimState()
        state.activateA()
        state.writeLease(engineA, "lease-1")
        state.clearLease(engineA)

        assertNull(state.activateA()["lease"])
    }

    @Test
    fun `a lease written by a non-owner is ignored`() {
        val state = ShimState()
        state.activateA()
        state.activate(engineB, DEVICE) {}
        state.writeLease(engineB, "intruder")

        assertNull(state.activateA()["lease"])
    }

    @Test
    fun `before activate a link is remembered but not claimed`() {
        val state = ShimState()

        assertFalse(state.onLink(LINK))
        assertEquals(emptyList<String>(), received)
    }

    @Test
    fun `activate returns only the latest link received before it`() {
        val state = ShimState()
        state.onLink("myapp:///?appduct=OLD")
        state.onLink(LINK)

        assertEquals(listOf(LINK), state.activateA()["links"])
        assertEquals(emptyList<String>(), state.activateA()["links"])
    }

    @Test
    fun `before activate nothing is stored for a lease write`() {
        val state = ShimState()
        state.writeLease(engineA, "early")

        assertNull(state.activateA()["lease"])
    }

    @Test
    fun `after activate a link is sent to Dart and claimed`() {
        val state = ShimState()
        state.activateA()

        assertTrue(state.onLink(LINK))
        assertEquals(listOf(LINK), received)
    }

    @Test
    fun `a link that does not carry appduct passes through`() {
        val state = ShimState()
        state.activateA()

        assertFalse(state.onLink("myapp:///profile?id=1"))
        assertFalse(state.onLink("myapp:///profile?notappduct=1"))
        assertFalse(state.onLink("myapp:///profile#?appduct=1"))
        assertEquals(emptyList<String>(), received)
    }

    @Test
    fun `a link arriving while no engine is attached is remembered for the next activate`() {
        val state = ShimState()
        state.activateA()
        state.release(engineA)

        assertFalse(state.onLink(LINK))
        assertEquals(listOf(LINK), state.activate(engineB, DEVICE) {}["links"])
    }
}
