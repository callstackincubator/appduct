package com.callstack.appduct

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of the tool-descriptor validation half of `registry.ts` / `@appduct/shared`'s
 * `isToolDescriptor` (PROTOCOL.md §5), plus `registry.ts`'s upsert-by-name/order-preservation
 * contract. */
class AppductToolRegistryTest {
    private val noopHandler: AppductToolHandler = { _, _ -> null }

    private fun descriptor(
        name: String = "sum",
        description: String = "Add two numbers.",
        annotations: JSONObject? = null,
        timeoutMs: Long? = null,
    ) = AppductToolDescriptor(name, description, annotations = annotations, timeoutMs = timeoutMs)

    // --- name ---

    @Test
    fun `valid names are accepted`() {
        for (name in listOf("a", "sum", "sum_two", "sum-two", "A1_-2", "x".repeat(64))) {
            validateAppductToolDescriptor(descriptor(name = name))
        }
    }

    @Test
    fun `invalid names are rejected`() {
        for (name in listOf("", "x".repeat(65), "has space", "has.dot", "emoji😀")) {
            assertThrows(AppductInvalidToolDescriptorException::class.java) {
                validateAppductToolDescriptor(descriptor(name = name))
            }
        }
    }

    // --- description ---

    @Test
    fun `empty description is rejected`() {
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            validateAppductToolDescriptor(descriptor(description = ""))
        }
    }

    @Test
    fun `description over 4096 chars is rejected`() {
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            validateAppductToolDescriptor(descriptor(description = "x".repeat(4097)))
        }
    }

    @Test
    fun `description at exactly 4096 chars is accepted`() {
        validateAppductToolDescriptor(descriptor(description = "x".repeat(4096)))
    }

    // --- annotations ---

    @Test
    fun `known boolean annotation keys are accepted`() {
        val annotations =
            JSONObject().put("readOnlyHint", true).put("destructiveHint", false).put("idempotentHint", true)
        validateAppductToolDescriptor(descriptor(annotations = annotations))
    }

    @Test
    fun `unknown annotation key is rejected`() {
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            validateAppductToolDescriptor(descriptor(annotations = JSONObject().put("bogusHint", true)))
        }
    }

    @Test
    fun `non-boolean annotation value is rejected`() {
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            validateAppductToolDescriptor(descriptor(annotations = JSONObject().put("readOnlyHint", "yes")))
        }
    }

    // --- timeout_ms ---

    @Test
    fun `positive timeoutMs is accepted`() {
        validateAppductToolDescriptor(descriptor(timeoutMs = 60_000L))
    }

    @Test
    fun `zero or negative timeoutMs is rejected`() {
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            validateAppductToolDescriptor(descriptor(timeoutMs = 0L))
        }
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            validateAppductToolDescriptor(descriptor(timeoutMs = -1L))
        }
    }

    // --- timeout_ms clamping (fix for issue #48 review: native cores must clamp like the JS
    // registry used to via clampToolTimeoutMs, packages/shared/src/domains/tool-descriptor.ts) ---

    @Test
    fun `upsert clamps a timeoutMs below the minimum`() {
        val registry = AppductToolRegistry()
        val delta = registry.upsert(descriptor(timeoutMs = 50L), noopHandler)

        assertEquals(APPDUCT_MIN_TOOL_TIMEOUT_MS, registry.get("sum")?.descriptor?.timeoutMs)
        assertEquals(APPDUCT_MIN_TOOL_TIMEOUT_MS, (delta as AppductRegistryDelta.Upsert).descriptor.timeoutMs)
    }

    @Test
    fun `upsert clamps a timeoutMs above the maximum`() {
        val registry = AppductToolRegistry()
        val delta = registry.upsert(descriptor(timeoutMs = 5_000_000L), noopHandler)

        assertEquals(APPDUCT_MAX_TOOL_TIMEOUT_MS, registry.get("sum")?.descriptor?.timeoutMs)
        assertEquals(APPDUCT_MAX_TOOL_TIMEOUT_MS, (delta as AppductRegistryDelta.Upsert).descriptor.timeoutMs)
    }

    @Test
    fun `wire snapshot carries the clamped timeoutMs`() {
        val registry = AppductToolRegistry()
        registry.upsert(descriptor(timeoutMs = 5_000_000L), noopHandler)

        val snapshot = registry.snapshotWireJson()
        assertEquals(APPDUCT_MAX_TOOL_TIMEOUT_MS, snapshot[0].getLong("timeout_ms"))
    }

    // --- group ---

    @Test
    fun `one- or two-segment groups are accepted`() {
        for (group in listOf("checkout", "checkout/payment", "A1_-2/b", "x".repeat(64) + "/" + "y".repeat(64))) {
            validateAppductToolDescriptor(AppductToolDescriptor("sum", "Add.", group = group))
        }
    }

    @Test
    fun `malformed groups are rejected`() {
        for (group in listOf("", "/", "checkout/", "/payment", "a//b", "a/b/c", "a b", "checkout\n", "x".repeat(65))) {
            assertThrows(group, AppductInvalidToolDescriptorException::class.java) {
                validateAppductToolDescriptor(AppductToolDescriptor("sum", "Add.", group = group))
            }
        }
    }

    @Test
    fun `group round-trips through fromJson and the wire snapshot`() {
        val parsed = AppductToolDescriptor.fromJson("""{"name":"pay","description":"Pay.","group":"checkout/payment"}""")
        assertEquals("checkout/payment", parsed.group)

        val registry = AppductToolRegistry()
        registry.upsert(parsed, noopHandler)
        assertEquals("checkout/payment", registry.snapshotWireJson()[0].getString("group"))

        registry.upsert(descriptor(name = "ungrouped"), noopHandler)
        assertTrue(!registry.snapshotWireJson()[1].has("group"))
    }

    @Test
    fun `a non-string or null group is rejected by fromJson`() {
        for (raw in listOf("42", "null", "[\"a\"]")) {
            assertThrows(raw, AppductInvalidToolDescriptorException::class.java) {
                AppductToolDescriptor.fromJson("""{"name":"pay","description":"Pay.","group":$raw}""")
            }
        }
    }

    @Test
    fun `an in-range timeoutMs is stored unchanged`() {
        val registry = AppductToolRegistry()
        registry.upsert(descriptor(timeoutMs = 30_000L), noopHandler)

        assertEquals(30_000L, registry.get("sum")?.descriptor?.timeoutMs)
    }

    // --- registry: upsert order, delta shape, unregister no-op ---

    @Test
    fun `upsert by name preserves registration order`() {
        val registry = AppductToolRegistry()
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
        val registry = AppductToolRegistry()
        val delta = registry.upsert(descriptor(name = "a"), noopHandler)
        assertTrue(delta is AppductRegistryDelta.Upsert)
        assertEquals("a", (delta as AppductRegistryDelta.Upsert).descriptor.name)
    }

    @Test
    fun `an invalid descriptor is never stored`() {
        val registry = AppductToolRegistry()
        assertThrows(AppductInvalidToolDescriptorException::class.java) {
            registry.upsert(descriptor(name = "bad name"), noopHandler)
        }
        assertNull(registry.get("bad name"))
    }

    @Test
    fun `remove returns a Remove delta, or null for an unregistered name`() {
        val registry = AppductToolRegistry()
        registry.upsert(descriptor(name = "a"), noopHandler)

        val delta = registry.remove("a")
        assertTrue(delta is AppductRegistryDelta.Remove)
        assertEquals("a", delta!!.name)
        assertNull(registry.get("a"))

        assertNull(registry.remove("a"))
        assertNull(registry.remove("never-registered"))
    }

    @Test
    fun `snapshotWireJson round-trips the wire shape`() {
        val registry = AppductToolRegistry()
        registry.upsert(
            AppductToolDescriptor(
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
