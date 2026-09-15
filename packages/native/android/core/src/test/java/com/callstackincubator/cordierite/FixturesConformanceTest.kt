package com.callstackincubator.cordierite

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * Cross-language conformance fixtures (issue #48, "Parity is the risk"): every vector loaded here
 * also loads and asserts in TypeScript
 * (`packages/shared/src/__tests__/fixtures-conformance.test.ts`,
 * `packages/cordierite/src/__tests__/spki-pin.test.ts`) and Swift
 * (`packages/native/ios/Tests/CordieriteCoreTests/FixturesConformanceTests.swift`) against their
 * own implementations of the same rules. See `packages/native/fixtures/README.md` for the rule
 * that a divergence found this way is fixed in the implementation that disagrees with
 * `docs/PROTOCOL.md`, never in the fixture.
 *
 * Robolectric-backed for the same reason [CordieriteSpkiPinTest]/[CordieriteBootstrapCodecTest]
 * are: `decodeCordieriteBootstrap`/`parseCordieriteBootstrapUrl` reach `android.util.Base64`,
 * which is a "not mocked" stub on the plain JVM.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class FixturesConformanceTest {
    /**
     * `packages/native/fixtures`. Under Gradle, `System.getProperty("user.dir")` for
     * `:core:testDebugUnitTest` is this module's own project directory
     * (`packages/native/android/core`) -- verified empirically when this test was written --
     * so `../../fixtures` from there is `packages/native/fixtures`. Falls back to walking up
     * from `user.dir` looking for a `packages/native/fixtures` directory, in case a future
     * Gradle/AGP version changes what `user.dir` points at.
     */
    private fun fixturesDir(): File {
        val userDir = File(System.getProperty("user.dir") ?: ".").canonicalFile
        val direct = File(userDir, "../../fixtures").canonicalFile
        if (direct.isDirectory) return direct

        var dir: File? = userDir
        while (dir != null) {
            val candidate = File(dir, "packages/native/fixtures")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        throw IllegalStateException(
            "Could not locate packages/native/fixtures from user.dir=$userDir (tried $direct and walking up).",
        )
    }

    private fun loadJsonArray(name: String): JSONArray = JSONArray(File(fixturesDir(), name).readText(Charsets.UTF_8))

    private fun loadJsonObject(name: String): JSONObject = JSONObject(File(fixturesDir(), name).readText(Charsets.UTF_8))

    // --- bootstrap-payloads.json ---

    @Test
    fun `bootstrap-payloads fixture matches decodeCordieriteBootstrap`() {
        val vectors = loadJsonArray("bootstrap-payloads.json")
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val name = vector.getString("name")
            val base64url = vector.getString("base64url")
            val decoded = decodeCordieriteBootstrap(base64url)

            if (vector.isNull("expected")) {
                assertNull(name, decoded)
                continue
            }

            val expected = vector.getJSONObject("expected")
            assertEquals(name, expected.getInt("family"), decoded?.family)
            assertEquals(name, expected.getString("address"), decoded?.address)
            assertEquals(name, expected.getInt("port"), decoded?.port)
            assertEquals(name, expected.getString("sessionId"), decoded?.sessionId)
            assertEquals(name, expected.getString("tokenBase64url"), decoded?.token)
            assertEquals(name, expected.getLong("expiresAt"), decoded?.expiresAt)
        }
    }

    // --- bootstrap-links.json ---

    @Test
    fun `bootstrap-links fixture matches parseCordieriteBootstrapUrl`() {
        val payloads = loadJsonArray("bootstrap-payloads.json")
        val links = loadJsonArray("bootstrap-links.json")
        assertTrue(links.length() > 0)

        for (i in 0 until links.length()) {
            val link = links.getJSONObject(i)
            val name = link.getString("name")
            val url = link.getString("url")
            val expected = link.getJSONObject("expected")
            val payloadIndex = expected.getInt("payloadIndex")
            val expectedPin = if (expected.isNull("pin")) null else expected.getString("pin")
            val expectedPayload = decodeCordieriteBootstrap(payloads.getJSONObject(payloadIndex).getString("base64url"))

            // nowSeconds = 0: every fixture payload's expiresAt is > 0 (some deliberately as low
            // as 1 second, to keep the shortest-payload link vector minimal), so this can never
            // trip the expiry check -- this test is about cordierite/pin extraction, not expiry.
            val parsed = parseCordieriteBootstrapUrl(url, nowSeconds = 0L, requirePrivateIp = true)

            assertEquals(name, expectedPayload, parsed.payload)
            assertEquals(name, expectedPin, parsed.linkPin)
        }
    }

    // --- tool-descriptors.json ---

    /**
     * Parses a fixture's raw `descriptor` JSON value through [CordieriteToolDescriptor.fromJson] --
     * the same wire-shape parser `NativeCordieriteModule.registerTool` calls, vendored like the
     * Swift/iOS equivalent (`parseToolDescriptor`) -- so the fixture actually drives the real
     * implementation under test end to end (structural parsing, then PROTOCOL.md §5 validation),
     * rather than a second, hand-maintained parser that could silently drift from it.
     */
    private fun parseFixtureToolDescriptor(raw: Any?): CordieriteToolDescriptor {
        if (raw !is JSONObject) {
            throw CordieriteInvalidToolDescriptorException("Tool descriptor must be a JSON object.")
        }

        val descriptor = CordieriteToolDescriptor.fromJson(raw.toString())
        validateCordieriteToolDescriptor(descriptor)
        return descriptor
    }

    @Test
    fun `tool-descriptors fixture matches validateCordieriteToolDescriptor`() {
        val vectors = loadJsonArray("tool-descriptors.json")
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val name = vector.getString("name")
            val expectedValid = vector.getBoolean("valid")
            val descriptorRaw = if (vector.isNull("descriptor")) null else vector.get("descriptor")

            val isValid =
                try {
                    parseFixtureToolDescriptor(descriptorRaw)
                    true
                } catch (_: CordieriteInvalidToolDescriptorException) {
                    false
                }

            assertEquals(name, expectedValid, isValid)
        }
    }

    // --- close-codes.json ---

    @Test
    fun `close-codes fixture matches isCordieriteTerminalCloseCode`() {
        val vectors = loadJsonArray("close-codes.json")
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val code = if (vector.isNull("code")) null else vector.getInt("code")
            val terminal = vector.getBoolean("terminal")

            assertEquals("vector #$i (code=$code)", terminal, isCordieriteTerminalCloseCode(code))
        }
    }

    @Test
    fun `only close code 1008 is ever terminal`() {
        val vectors = loadJsonArray("close-codes.json")

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            if (vector.getBoolean("terminal")) {
                assertEquals(1_008, vector.getInt("code"))
            }
        }
    }

    // --- spki-pin.json ---

    @Test
    fun `spki-pin fixture matches computeSpkiPin`() {
        val fixture = loadJsonObject("spki-pin.json")
        val der = Base64.getDecoder().decode(fixture.getString("certificateDerBase64"))
        val certificate =
            CertificateFactory
                .getInstance("X.509")
                .generateCertificate(der.inputStream()) as X509Certificate

        assertEquals(fixture.getString("expectedPin"), computeSpkiPin(certificate))
    }
}
