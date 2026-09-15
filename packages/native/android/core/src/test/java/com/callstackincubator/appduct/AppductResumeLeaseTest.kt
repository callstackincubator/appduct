package com.callstackincubator.appduct

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of `resume-lease.ts`'s `parseResumeLease`/`isResumeLeaseExpired`. */
class AppductResumeLeaseTest {
    private fun validRecord(disconnectedAtMs: Long? = null): Map<String, Any?> =
        mapOf(
            "schemaVersion" to 1,
            "sessionId" to "sess-1",
            "resumeToken" to "resume-1",
            "alias" to "pixel-8",
            "endpoint" to mapOf("ip" to "192.168.1.10", "port" to 8443),
            "keepaliveIntervalS" to 15.0,
            "graceS" to 600.0,
            "disconnectedAtMs" to disconnectedAtMs,
        )

    @Test
    fun `parses a valid record`() {
        val lease = parseAppductResumeLease(validRecord())
        assertEquals("sess-1", lease?.sessionId)
        assertEquals("192.168.1.10", lease?.ip)
        assertEquals(8443, lease?.port)
    }

    @Test
    fun `null record parses to null`() {
        assertNull(parseAppductResumeLease(null))
    }

    @Test
    fun `wrong schemaVersion is rejected`() {
        assertNull(parseAppductResumeLease(validRecord() + ("schemaVersion" to 2)))
    }

    @Test
    fun `missing endpoint is rejected`() {
        assertNull(parseAppductResumeLease(validRecord() - "endpoint"))
    }

    @Test
    fun `invalid port is rejected`() {
        val record = validRecord().toMutableMap()
        record["endpoint"] = mapOf("ip" to "192.168.1.10", "port" to 0)
        assertNull(parseAppductResumeLease(record))
    }

    @Test
    fun `non-positive keepalive or grace is rejected`() {
        assertNull(parseAppductResumeLease(validRecord().toMutableMap().apply { this["keepaliveIntervalS"] = 0.0 }))
        assertNull(parseAppductResumeLease(validRecord().toMutableMap().apply { this["graceS"] = -1.0 }))
    }

    @Test
    fun `a lease with no disconnection timestamp is never expired`() {
        val lease = parseAppductResumeLease(validRecord(disconnectedAtMs = null))!!
        assertFalse(isAppductResumeLeaseExpired(lease, nowMs = Long.MAX_VALUE / 2))
    }

    @Test
    fun `a lease expires once grace seconds have elapsed since disconnection`() {
        val lease = parseAppductResumeLease(validRecord(disconnectedAtMs = 0L))!!
        assertFalse(isAppductResumeLeaseExpired(lease, nowMs = 599_000L))
        assertTrue(isAppductResumeLeaseExpired(lease, nowMs = 600_000L))
    }
}
