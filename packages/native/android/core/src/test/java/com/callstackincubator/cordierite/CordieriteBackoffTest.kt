package com.callstackincubator.cordierite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of `backoff.test.ts` -- full-jitter reconnect delay. */
class CordieriteBackoffTest {
    @Test
    fun `attempt 0 is bounded by the base delay`() {
        val delay = computeCordieriteFullJitterBackoffMs(0, random = { 0.999 })
        assertTrue(delay < CORDIERITE_BACKOFF_BASE_MS)
    }

    @Test
    fun `delay grows exponentially with attempt, capped`() {
        // random = 1.0 (clamped just under 1 in practice, but the formula's upper bound is exact
        // at 1.0) exercises the exact upper bound at each attempt.
        assertEquals(500L, computeCordieriteFullJitterBackoffMs(0, random = { 1.0 }))
        assertEquals(1000L, computeCordieriteFullJitterBackoffMs(1, random = { 1.0 }))
        assertEquals(2000L, computeCordieriteFullJitterBackoffMs(2, random = { 1.0 }))
        assertEquals(4000L, computeCordieriteFullJitterBackoffMs(3, random = { 1.0 }))
    }

    @Test
    fun `delay never exceeds the cap regardless of attempt`() {
        for (attempt in intArrayOf(6, 7, 20, 100)) {
            val delay = computeCordieriteFullJitterBackoffMs(attempt, random = { 1.0 })
            assertEquals(CORDIERITE_BACKOFF_CAP_MS, delay)
        }
    }

    @Test
    fun `a negative attempt behaves like attempt 0`() {
        assertEquals(500L, computeCordieriteFullJitterBackoffMs(-5, random = { 1.0 }))
    }

    @Test
    fun `zero random always yields zero delay`() {
        assertEquals(0L, computeCordieriteFullJitterBackoffMs(3, random = { 0.0 }))
    }

    @Test
    fun `custom base and cap are honored`() {
        assertEquals(100L, computeCordieriteFullJitterBackoffMs(0, baseMs = 100L, capMs = 5000L, random = { 1.0 }))
        assertEquals(5000L, computeCordieriteFullJitterBackoffMs(10, baseMs = 100L, capMs = 5000L, random = { 1.0 }))
    }
}
