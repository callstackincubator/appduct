package com.callstack.appduct

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64

/**
 * Robolectric-backed tests for the TLS pinning decision path.
 *
 * Everything here calls the *shipped* functions — `computeSpkiPin` and
 * `PinningTrustManager.checkServerTrusted` — which both reach `android.util.Base64`. That class is
 * a stub in the plain-JVM android.jar and throws "not mocked", which is why these tests live apart
 * from [AppductConnectionManagerTest] (still a plain-JVM class, still the fast path) and pull in
 * Robolectric to provide a real android.jar runtime. No emulator is involved: this runs inside the
 * same `:core:testDebugUnitTest` task, in the standalone `packages/native/android` Gradle project
 * (docs/tasks/14-native-core-extraction.md).
 *
 * The SDK level is pinned rather than inherited from the consuming app's `compileSdk` so the pin
 * math is exercised at a level Robolectric ships an android-all jar for, no matter which
 * `compileSdkVersion` the autolinked host project sets.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AppductSpkiPinTest {
    /**
     * The shared fixture certificate (DER, base64) also used by
     * `packages/native/ios/Tests/AppductCoreTests/FixturesConformanceTests.swift` and
     * `FixturesConformanceTest`'s own SPKI-pin test in this module -- sourced once from
     * `packages/native/fixtures/spki-pin.json` rather than duplicated as a string literal here.
     * See that file's `description` field for how it was generated. Only the public certificate
     * is stored; the private key was discarded after deriving [expectedPin] once.
     */
    private val fixtureCertificateDerBase64: String
        get() = fixtureJson.getString("certificateDerBase64")

    /**
     * Independently derived (Node.js) from the same certificate's key material using
     * `packages/appduct/src/spki-pin.ts`'s `createSpkiPin` — must match for the same leaf
     * certificate (and does match the iOS/Kotlin fixture-conformance tests' own computation).
     */
    private val expectedPin: String
        get() = fixtureJson.getString("expectedPin")

    private val fixtureJson: JSONObject by lazy {
        var dir: File? = File(System.getProperty("user.dir") ?: ".").canonicalFile
        while (dir != null) {
            val candidate = File(dir, "packages/native/fixtures/spki-pin.json")
            if (candidate.isFile) return@lazy JSONObject(candidate.readText(Charsets.UTF_8))
            dir = dir.parentFile
        }
        throw IllegalStateException("Could not locate packages/native/fixtures/spki-pin.json")
    }

    private val fixtureCertificate: X509Certificate
        get() =
            CertificateFactory
                .getInstance("X.509")
                .generateCertificate(Base64.getDecoder().decode(fixtureCertificateDerBase64).inputStream())
                as X509Certificate

    // MARK: - SPKI pin parity with packages/appduct/src/spki-pin.ts and iOS's spkiPin(for:)
    //
    // The "matches the TypeScript and iOS implementations" assertion this test used to make with
    // its own local fixture now lives once, cross-language, in FixturesConformanceTest's
    // `spki-pin fixture matches computeSpkiPin`.

    @Test
    fun `computeSpkiPin emits an unwrapped single-line pin`() {
        // NO_WRAP matters: a pin carrying a newline would never string-compare equal to the pin the
        // CLI puts in the bootstrap link or the manifest, so every connection would fail closed.
        val pin = computeSpkiPin(fixtureCertificate)

        assertEquals(pin.trim(), pin)
        assertEquals(1, pin.lines().size)
        assertEquals("sha256/", pin.take("sha256/".length))
    }

    // MARK: - PinningTrustManager decision path

    @Test
    fun `server certificate whose pin is accepted passes verification`() {
        PinningTrustManager(setOf(expectedPin))
            .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
    }

    @Test
    fun `server certificate is still accepted when the pin set holds other pins too`() {
        PinningTrustManager(setOf("sha256/some-other-pin", expectedPin))
            .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
    }

    @Test
    fun `server certificate whose pin is not accepted is rejected`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(setOf("sha256/some-other-pin"))
                .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `an empty pin set rejects every server certificate`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(emptySet())
                .checkServerTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `an empty certificate chain is rejected rather than treated as trusted`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(setOf(expectedPin))
                .checkServerTrusted(emptyArray(), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `client certificates are never trusted`() {
        assertThrows(CertificateException::class.java) {
            PinningTrustManager(setOf(expectedPin))
                .checkClientTrusted(arrayOf(fixtureCertificate), "ECDHE_ECDSA")
        }
    }

    @Test
    fun `no issuers are advertised as accepted`() {
        assertEquals(0, PinningTrustManager(setOf(expectedPin)).acceptedIssuers.size)
    }
}
