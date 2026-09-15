package com.callstackincubator.cordierite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of `resume-lease.ts`'s `parseResumeLease`/`isResumeLeaseExpired`. */
class CordieriteResumeLeaseTest {
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
        val lease = parseCordieriteResumeLease(validRecord())
        assertEquals("sess-1", lease?.sessionId)
        assertEquals("192.168.1.10", lease?.ip)
        assertEquals(8443, lease?.port)
    }

    @Test
    fun `null record parses to null`() {
        assertNull(parseCordieriteResumeLease(null))
    }

    @Test
    fun `wrong schemaVersion is rejected`() {
        assertNull(parseCordieriteResumeLease(validRecord() + ("schemaVersion" to 2)))
    }

    @Test
    fun `missing endpoint is rejected`() {
        assertNull(parseCordieriteResumeLease(validRecord() - "endpoint"))
    }

    @Test
    fun `invalid port is rejected`() {
        val record = validRecord().toMutableMap()
        record["endpoint"] = mapOf("ip" to "192.168.1.10", "port" to 0)
        assertNull(parseCordieriteResumeLease(record))
    }

    @Test
    fun `non-positive keepalive or grace is rejected`() {
        assertNull(parseCordieriteResumeLease(validRecord().toMutableMap().apply { this["keepaliveIntervalS"] = 0.0 }))
        assertNull(parseCordieriteResumeLease(validRecord().toMutableMap().apply { this["graceS"] = -1.0 }))
    }

    @Test
    fun `a lease with no disconnection timestamp is never expired`() {
        val lease = parseCordieriteResumeLease(validRecord(disconnectedAtMs = null))!!
        assertFalse(isCordieriteResumeLeaseExpired(lease, nowMs = Long.MAX_VALUE / 2))
    }

    @Test
    fun `a lease expires once grace seconds have elapsed since disconnection`() {
        val lease = parseCordieriteResumeLease(validRecord(disconnectedAtMs = 0L))!!
        assertFalse(isCordieriteResumeLeaseExpired(lease, nowMs = 599_000L))
        assertTrue(isCordieriteResumeLeaseExpired(lease, nowMs = 600_000L))
    }
}
