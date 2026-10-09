package com.callstack.appduct

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Cross-language conformance fixtures (issue #48, "Parity is the risk"): every vector loaded here
 * also loads and asserts in TypeScript
 * (`packages/shared/src/__tests__/fixtures-conformance.test.ts`,
 * `packages/appduct/src/__tests__/spki-pin.test.ts`) and Swift
 * (`packages/native/ios/Tests/AppductCoreTests/FixturesConformanceTests.swift`) against their
 * own implementations of the same rules. See `packages/native/fixtures/README.md` for the rule
 * that a divergence found this way is fixed in the implementation that disagrees with
 * `docs/PROTOCOL.md`, never in the fixture.
 *
 * Robolectric-backed for the same reason [AppductSpkiPinTest]/[AppductBootstrapCodecTest]
 * are: `decodeAppductBootstrap`/`parseAppductBootstrapUrl` reach `android.util.Base64`,
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
    fun `bootstrap-payloads fixture matches decodeAppductBootstrap`() {
        val vectors = loadJsonArray("bootstrap-payloads.json")
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val name = vector.getString("name")
            val base64url = vector.getString("base64url")
            val decoded = decodeAppductBootstrap(base64url)

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
    fun `bootstrap-links fixture matches parseAppductBootstrapUrl`() {
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
            val expectedPayload = decodeAppductBootstrap(payloads.getJSONObject(payloadIndex).getString("base64url"))

            // nowSeconds = 0: every fixture payload's expiresAt is > 0 (some deliberately as low
            // as 1 second, to keep the shortest-payload link vector minimal), so this can never
            // trip the expiry check -- this test is about appduct/pin extraction, not expiry.
            val parsed = parseAppductBootstrapUrl(url, nowSeconds = 0L, requirePrivateIp = true)

            assertEquals(name, expectedPayload, parsed.payload)
            assertEquals(name, expectedPin, parsed.linkPin)
        }
    }

    // --- tool-descriptors.json ---

    /**
     * Parses a fixture's raw `descriptor` JSON value through [AppductToolDescriptor.fromJson] --
     * the same wire-shape parser `NativeAppductModule.registerTool` calls, vendored like the
     * Swift/iOS equivalent (`parseToolDescriptor`) -- so the fixture actually drives the real
     * implementation under test end to end (structural parsing, then PROTOCOL.md §5 validation),
     * rather than a second, hand-maintained parser that could silently drift from it.
     */
    private fun parseFixtureToolDescriptor(raw: Any?): AppductToolDescriptor {
        if (raw !is JSONObject) {
            throw AppductInvalidToolDescriptorException("Tool descriptor must be a JSON object.")
        }

        val descriptor = AppductToolDescriptor.fromJson(raw.toString())
        validateAppductToolDescriptor(descriptor)
        return descriptor
    }

    @Test
    fun `tool-descriptors fixture matches validateAppductToolDescriptor`() {
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
                } catch (_: AppductInvalidToolDescriptorException) {
                    false
                }

            assertEquals(name, expectedValid, isValid)
        }
    }

    // --- event-descriptors.json ---

    @Test
    fun `event-descriptors fixture matches validateAppductEventDescriptor`() {
        val vectors = loadJsonArray("event-descriptors.json")
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val name = vector.getString("name")
            val descriptorRaw = if (vector.isNull("descriptor")) null else vector.get("descriptor")

            val isValid =
                try {
                    if (descriptorRaw !is JSONObject) throw AppductInvalidEventDescriptorException("not an object")
                    validateAppductEventDescriptor(AppductEventDescriptor.fromJson(descriptorRaw.toString()))
                    true
                } catch (_: AppductInvalidEventDescriptorException) {
                    false
                }

            assertEquals(name, vector.getBoolean("valid"), isValid)
        }
    }

    // --- close-codes.json ---

    @Test
    fun `close-codes fixture matches isAppductTerminalCloseCode`() {
        val vectors = loadJsonArray("close-codes.json")
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val code = if (vector.isNull("code")) null else vector.getInt("code")
            val terminal = vector.getBoolean("terminal")

            assertEquals("vector #$i (code=$code)", terminal, isAppductTerminalCloseCode(code))
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

    // --- frame-limits.json ---

    private fun utf8Bytes(text: String): Int = text.toByteArray(Charsets.UTF_8).size

    /** A string that makes a frame carrying it exactly `frameBytes` long, given the frame's size with `""`. */
    private fun padding(
        frameBytes: Int,
        filler: String,
        emptyFrameBytes: Int,
    ): String {
        val pad = frameBytes - emptyFrameBytes
        val unit = utf8Bytes(filler)
        val count = pad / unit
        return filler.repeat(count) + "a".repeat(pad - count * unit)
    }

    private fun newActiveClient(
        errors: MutableList<AppductUnifiedError>,
    ): Pair<AppductClient, FakeAppductTransport> {
        lateinit var fake: FakeAppductTransport
        val client =
            AppductClient(
                transportFactory = { _, onMessage, onError, onClose ->
                    FakeAppductTransport(onMessage, onError, onClose).also { fake = it }
                },
                lifecycleObserverFactory = { AppductNoopLifecycleObserver() },
            )
        client.addErrorListener { errors.add(it) }
        runBlocking {
            val job =
                launch(Dispatchers.Default) {
                    client.connect(
                        AppductConnectInput.Explicit(
                            ip = "127.0.0.1",
                            port = 8443,
                            sessionId = "sess-1",
                            token = "claim-token",
                            resumeToken = null,
                            expiresAt = Long.MAX_VALUE / 2,
                            linkPin = null,
                        ),
                    )
                }
            waitUntil { fake.connectCalls.isNotEmpty() }
            fake.simulateAck("sess-1")
            job.join()
        }
        return client to fake
    }

    private fun framesOfType(
        fake: FakeAppductTransport,
        type: String,
    ): List<JSONObject> = fake.sentMessages.map { JSONObject(it) }.filter { it.getString("type") == type }

    @Test
    fun `frame-limits fixture decides which tool results are sent and which become tool_serialization_error`() {
        val fixture = loadJsonObject("frame-limits.json")
        val limitBytes = fixture.getInt("limitBytes")
        val vectors = fixture.getJSONArray("vectors")
        assertEquals(262_144, limitBytes)
        assertTrue(vectors.length() > 0)

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val name = vector.getString("name")
            val frameBytes = vector.getInt("frameBytes")
            val errors = CopyOnWriteArrayList<AppductUnifiedError>()
            val (client, fake) = newActiveClient(errors)
            var answer = ""
            client.registerTool(AppductToolDescriptor(name = "big", description = "Returns a string.")) { _, _ -> answer }
            waitUntil { framesOfType(fake, "tool_registry_delta").isNotEmpty() }

            fun call(id: String) =
                fake.simulateMessage(
                    JSONObject().put("type", "tool_call").put("session_id", "sess-1").put("id", id).put("name", "big").put("args", JSONObject()),
                )

            call("id-a")
            waitUntil { framesOfType(fake, "tool_result").size == 1 }
            val emptyFrameBytes = utf8Bytes(framesOfType(fake, "tool_result").first().toString())

            answer = padding(frameBytes, vector.getString("filler"), emptyFrameBytes)
            call("id-b")

            if (vector.getBoolean("sent")) {
                waitUntil { framesOfType(fake, "tool_result").size == 2 }
                assertEquals(name, frameBytes, utf8Bytes(fake.sentMessages.last()))
            } else {
                waitUntil { framesOfType(fake, "tool_error").isNotEmpty() }
                assertEquals(name, 1, framesOfType(fake, "tool_result").size)
                val error = framesOfType(fake, "tool_error").single()
                assertEquals(name, "id-b", error.getString("id"))
                assertEquals(name, "tool_serialization_error", error.getJSONObject("error").getString("type"))
                assertEquals(
                    name,
                    "Appduct frame is $frameBytes bytes, over the $limitBytes-byte limit.",
                    error.getJSONObject("error").getString("message"),
                )
            }
            assertEquals(name, AppductClientState.active, client.state)
        }
    }

    @Test
    fun `frame-limits fixture decides which events are sent and which go to the error listener`() {
        val fixture = loadJsonObject("frame-limits.json")
        val limitBytes = fixture.getInt("limitBytes")
        val vectors = fixture.getJSONArray("vectors")

        for (i in 0 until vectors.length()) {
            val vector = vectors.getJSONObject(i)
            val name = vector.getString("name")
            val frameBytes = vector.getInt("frameBytes")
            val errors = CopyOnWriteArrayList<AppductUnifiedError>()
            val (client, fake) = newActiveClient(errors)
            waitUntil { framesOfType(fake, "tool_registry_snapshot").isNotEmpty() }

            runBlocking {
                client.postEvent("big", "")
                val emptyFrameBytes = utf8Bytes(fake.sentMessages.last())
                client.postEvent("big", padding(frameBytes, vector.getString("filler"), emptyFrameBytes))
            }

            if (vector.getBoolean("sent")) {
                assertEquals(name, 2, framesOfType(fake, "event").size)
                assertEquals(name, frameBytes, utf8Bytes(fake.sentMessages.last()))
                assertTrue(name, errors.isEmpty())
            } else {
                assertEquals(name, 1, framesOfType(fake, "event").size)
                assertEquals(name, 1, errors.size)
                assertEquals(name, "socket", errors.single().phase)
                assertEquals(name, "Appduct frame is $frameBytes bytes, over the $limitBytes-byte limit.", errors.single().message)
            }
            assertEquals(name, AppductClientState.active, client.state)
        }
    }
}
