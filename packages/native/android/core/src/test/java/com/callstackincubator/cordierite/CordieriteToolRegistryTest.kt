package com.callstackincubator.cordierite

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of the tool-descriptor validation half of `registry.ts` / `@cordierite/shared`'s
 * `isToolDescriptor` (PROTOCOL.md §5), plus `registry.ts`'s upsert-by-name/order-preservation
 * contract. */
class CordieriteToolRegistryTest {
    private val noopHandler: CordieriteToolHandler = { _, _ -> null }

    private fun descriptor(
        name: String = "sum",
        description: String = "Add two numbers.",
        annotations: JSONObject? = null,
        timeoutMs: Long? = null,
    ) = CordieriteToolDescriptor(name, description, annotations = annotations, timeoutMs = timeoutMs)

    // --- name ---

    @Test
    fun `valid names are accepted`() {
        for (name in listOf("a", "sum", "sum_two", "sum-two", "A1_-2", "x".repeat(64))) {
            validateCordieriteToolDescriptor(descriptor(name = name))
        }
    }

    @Test
    fun `invalid names are rejected`() {
        for (name in listOf("", "x".repeat(65), "has space", "has.dot", "emoji😀")) {
            assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
                validateCordieriteToolDescriptor(descriptor(name = name))
            }
        }
    }

    // --- description ---

    @Test
    fun `empty description is rejected`() {
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            validateCordieriteToolDescriptor(descriptor(description = ""))
        }
    }

    @Test
    fun `description over 4096 chars is rejected`() {
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            validateCordieriteToolDescriptor(descriptor(description = "x".repeat(4097)))
        }
    }

    @Test
    fun `description at exactly 4096 chars is accepted`() {
        validateCordieriteToolDescriptor(descriptor(description = "x".repeat(4096)))
    }

    // --- annotations ---

    @Test
    fun `known boolean annotation keys are accepted`() {
        val annotations =
            JSONObject().put("readOnlyHint", true).put("destructiveHint", false).put("idempotentHint", true)
        validateCordieriteToolDescriptor(descriptor(annotations = annotations))
    }

    @Test
    fun `unknown annotation key is rejected`() {
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            validateCordieriteToolDescriptor(descriptor(annotations = JSONObject().put("bogusHint", true)))
        }
    }

    @Test
    fun `non-boolean annotation value is rejected`() {
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            validateCordieriteToolDescriptor(descriptor(annotations = JSONObject().put("readOnlyHint", "yes")))
        }
    }

    // --- timeout_ms ---

    @Test
    fun `positive timeoutMs is accepted`() {
        validateCordieriteToolDescriptor(descriptor(timeoutMs = 60_000L))
    }

    @Test
    fun `zero or negative timeoutMs is rejected`() {
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            validateCordieriteToolDescriptor(descriptor(timeoutMs = 0L))
        }
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            validateCordieriteToolDescriptor(descriptor(timeoutMs = -1L))
        }
    }

    // --- registry: upsert order, delta shape, unregister no-op ---

    @Test
    fun `upsert by name preserves registration order`() {
        val registry = CordieriteToolRegistry()
        registry.upsert(descriptor(name = "a"), noopHandler)
        registry.upsert(descriptor(name = "b"), noopHandler)
        registry.upsert(descriptor(name = "c"), noopHandler)
        // Re-register "a" -- must not move to the end.
        registry.upsert(descriptor(name = "a", description = "updated"), noopHandler)

        assertEquals(listOf("a", "b", "c"), registry.descriptors().map { it.name })
        assertEquals("updated", registry.get("a")?.descriptor?.description)
    }

    @Test
    fun `upsert returns an Upsert delta with the descriptor`() {
        val registry = CordieriteToolRegistry()
        val delta = registry.upsert(descriptor(name = "a"), noopHandler)
        assertTrue(delta is CordieriteRegistryDelta.Upsert)
        assertEquals("a", (delta as CordieriteRegistryDelta.Upsert).descriptor.name)
    }

    @Test
    fun `an invalid descriptor is never stored`() {
        val registry = CordieriteToolRegistry()
        assertThrows(CordieriteInvalidToolDescriptorException::class.java) {
            registry.upsert(descriptor(name = "bad name"), noopHandler)
        }
        assertNull(registry.get("bad name"))
    }

    @Test
    fun `remove returns a Remove delta, or null for an unregistered name`() {
        val registry = CordieriteToolRegistry()
        registry.upsert(descriptor(name = "a"), noopHandler)

        val delta = registry.remove("a")
        assertTrue(delta is CordieriteRegistryDelta.Remove)
        assertEquals("a", delta!!.name)
        assertNull(registry.get("a"))

        assertNull(registry.remove("a"))
        assertNull(registry.remove("never-registered"))
    }

    @Test
    fun `snapshotWireJson round-trips the wire shape`() {
        val registry = CordieriteToolRegistry()
        registry.upsert(
            CordieriteToolDescriptor(
                name = "sum",
                description = "Add two numbers.",
                inputSchema = JSONObject().put("type", "object"),
                timeoutMs = 5000L,
            ),
            noopHandler,
        )

        val snapshot = registry.snapshotWireJson()
        assertEquals(1, snapshot.size)
        val json = snapshot[0]
        assertEquals("sum", json.getString("name"))
        assertEquals("Add two numbers.", json.getString("description"))
        assertEquals("object", json.getJSONObject("input_schema").getString("type"))
        assertEquals(5000L, json.getLong("timeout_ms"))
        assertTrue(!json.has("output_schema"))
    }
}
