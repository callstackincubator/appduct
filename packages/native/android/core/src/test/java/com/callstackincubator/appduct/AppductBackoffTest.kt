package com.callstackincubator.appduct

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of `backoff.test.ts` -- full-jitter reconnect delay. */
class AppductBackoffTest {
    @Test
    fun `attempt 0 is bounded by the base delay`() {
        val delay = computeAppductFullJitterBackoffMs(0, random = { 0.999 })
        assertTrue(delay < APPDUCT_BACKOFF_BASE_MS)
    }

    @Test
    fun `delay grows exponentially with attempt, capped`() {
        // random = 1.0 (clamped just under 1 in practice, but the formula's upper bound is exact
        // at 1.0) exercises the exact upper bound at each attempt.
        assertEquals(500L, computeAppductFullJitterBackoffMs(0, random = { 1.0 }))
        assertEquals(1000L, computeAppductFullJitterBackoffMs(1, random = { 1.0 }))
        assertEquals(2000L, computeAppductFullJitterBackoffMs(2, random = { 1.0 }))
        assertEquals(4000L, computeAppductFullJitterBackoffMs(3, random = { 1.0 }))
    }

    @Test
    fun `delay never exceeds the cap regardless of attempt`() {
        for (attempt in intArrayOf(6, 7, 20, 100)) {
            val delay = computeAppductFullJitterBackoffMs(attempt, random = { 1.0 })
            assertEquals(APPDUCT_BACKOFF_CAP_MS, delay)
        }
    }

    @Test
    fun `a negative attempt behaves like attempt 0`() {
        assertEquals(500L, computeAppductFullJitterBackoffMs(-5, random = { 1.0 }))
    }

    @Test
    fun `zero random always yields zero delay`() {
        assertEquals(0L, computeAppductFullJitterBackoffMs(3, random = { 0.0 }))
    }

    @Test
    fun `custom base and cap are honored`() {
        assertEquals(100L, computeAppductFullJitterBackoffMs(0, baseMs = 100L, capMs = 5000L, random = { 1.0 }))
        assertEquals(5000L, computeAppductFullJitterBackoffMs(10, baseMs = 100L, capMs = 5000L, random = { 1.0 }))
    }
}
