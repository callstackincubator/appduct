package com.callstackincubator.cordierite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of `terminal-close.ts`. */
class CordieriteTerminalCloseTest {
    @Test
    fun `1008 is terminal`() {
        assertTrue(isCordieriteTerminalCloseCode(1008))
    }

    @Test
    fun `1000, 1001, 1006, 1011, and null are not terminal`() {
        for (code in listOf(1000, 1001, 1006, 1011, null)) {
            assertFalse(isCordieriteTerminalCloseCode(code))
        }
    }

    @Test
    fun `terminal close reason echoes the daemon's wire reason when present`() {
        assertEquals("unknown_session", cordieriteTerminalCloseReason("unknown_session"))
    }

    @Test
    fun `terminal close reason falls back when the daemon sent none`() {
        assertEquals("rejected_by_daemon", cordieriteTerminalCloseReason(null))
    }
}
