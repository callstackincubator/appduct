package com.callstackincubator.cordierite

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric-backed (see [CordieriteSpkiPinTest] for why -- `android.util.Base64` is a "not
 * mocked" stub on the plain JVM). Port of `@cordierite/shared`'s bootstrap codec tests
 * (`decodeBootstrap`) and `deep-link-core.ts`'s `hasCordieriteBootstrapQuery`/link-pin extraction.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class CordieriteBootstrapCodecTest {
    private fun sampleBase64Url(
        family: Int = 0x04,
        addressBytes: IntArray = intArrayOf(192, 168, 1, 10),
        port: Int = 8443,
        sessionId: String = "session-123",
        tokenByte: Int = 0x42,
        expiresAt: Long = 9_999_999_999L,
        version: Int = 0x02,
    ): String {
        val sessionIdBytes = sessionId.toByteArray(Charsets.UTF_8)
        val total = 1 + 1 + addressBytes.size + 2 + 1 + sessionIdBytes.size + 32 + 8
        val bytes = ByteArray(total)
        var offset = 0
        bytes[offset++] = version.toByte()
        bytes[offset++] = family.toByte()
        for (b in addressBytes) bytes[offset++] = b.toByte()
        bytes[offset++] = ((port shr 8) and 0xff).toByte()
        bytes[offset++] = (port and 0xff).toByte()
        bytes[offset++] = sessionIdBytes.size.toByte()
        sessionIdBytes.forEach { bytes[offset++] = it }
        repeat(32) { bytes[offset++] = tokenByte.toByte() }
        for (i in 7 downTo 0) bytes[offset++] = ((expiresAt shr (i * 8)) and 0xff).toByte()

        return android.util.Base64.encodeToString(
            bytes,
            android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING or android.util.Base64.URL_SAFE,
        )
    }

    @Test
    fun `decodes a well-formed IPv4 payload`() {
        val decoded = decodeCordieriteBootstrap(sampleBase64Url())
        assertNotNull(decoded)
        assertEquals(4, decoded!!.family)
        assertEquals("192.168.1.10", decoded.address)
        assertEquals(8443, decoded.port)
        assertEquals("session-123", decoded.sessionId)
        assertEquals(9_999_999_999L, decoded.expiresAt)
    }

    @Test
    fun `decodes a well-formed IPv6 payload`() {
        val addressBytes =
            intArrayOf(0xfd, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1)
        val decoded = decodeCordieriteBootstrap(sampleBase64Url(family = 0x06, addressBytes = addressBytes))
        assertNotNull(decoded)
        assertEquals(6, decoded!!.family)
        assertEquals("fd00::1", decoded.address)
    }

    @Test
    fun `rejects a v1 version byte with no fallback`() {
        assertNull(decodeCordieriteBootstrap(sampleBase64Url(version = 0x01)))
    }

    @Test
    fun `rejects an unknown family byte`() {
        assertNull(decodeCordieriteBootstrap(sampleBase64Url(family = 0x05)))
    }

    @Test
    fun `rejects a truncated buffer`() {
        val full = sampleBase64Url()
        val truncated = full.substring(0, full.length / 2)
        assertNull(decodeCordieriteBootstrap(truncated))
    }

    @Test
    fun `rejects a zero-length session id`() {
        assertNull(decodeCordieriteBootstrap(sampleBase64Url(sessionId = "")))
    }

    @Test
    fun `rejects port 0`() {
        assertNull(decodeCordieriteBootstrap(sampleBase64Url(port = 0)))
    }

    @Test
    fun `rejects garbage input`() {
        assertNull(decodeCordieriteBootstrap("not-valid-base64!!!"))
        assertNull(decodeCordieriteBootstrap(""))
    }

    @Test
    fun `round-trips through the wire query string, stopping at the pin param`() {
        val payload = sampleBase64Url()
        val url = "myapp:///?cordierite=$payload&pin=sha256%2F${"A".repeat(43)}%3D"

        assertTrue(hasCordieriteBootstrapQuery(url))

        val parsed = parseCordieriteBootstrapUrl(url, nowSeconds = 0, requirePrivateIp = false)
        assertEquals("session-123", parsed.payload.sessionId)
        assertEquals("sha256/${"A".repeat(43)}=", parsed.linkPin)
    }

    @Test
    fun `hasCordieriteBootstrapQuery is false for URLs without the cordierite param`() {
        assertFalse(hasCordieriteBootstrapQuery(null))
        assertFalse(hasCordieriteBootstrapQuery(""))
        assertFalse(hasCordieriteBootstrapQuery("myapp:///?other=1"))
    }

    @Test
    fun `an expired payload is rejected`() {
        val payload = sampleBase64Url(expiresAt = 100)
        val url = "myapp:///?cordierite=$payload"
        assertThrowsParseError<BootstrapUrlParseError.ExpiredPayload> {
            parseCordieriteBootstrapUrl(url, nowSeconds = 200, requirePrivateIp = false)
        }
    }

    @Test
    fun `a non-local address is rejected when requirePrivateIp is true`() {
        val payload = sampleBase64Url(addressBytes = intArrayOf(8, 8, 8, 8))
        val url = "myapp:///?cordierite=$payload"
        assertThrowsParseError<BootstrapUrlParseError.InvalidPayload> {
            parseCordieriteBootstrapUrl(url, nowSeconds = 0, requirePrivateIp = true)
        }
    }

    @Test
    fun `a missing cordierite param is rejected`() {
        assertThrowsParseError<BootstrapUrlParseError.MissingPayload> {
            parseCordieriteBootstrapUrl("myapp:///?other=1", nowSeconds = 0, requirePrivateIp = false)
        }
    }

    private inline fun <reified T : BootstrapUrlParseError> assertThrowsParseError(block: () -> Unit) {
        try {
            block()
            throw AssertionError("Expected ${T::class.simpleName} to be thrown")
        } catch (e: BootstrapUrlParseError) {
            assertTrue("Expected ${T::class.simpleName}, got ${e::class.simpleName}", e is T)
        }
    }
}
