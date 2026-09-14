package com.callstackincubator.cordierite

import android.content.Intent
import android.net.Uri
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * Robolectric coverage for the trampoline activity (docs/tasks/19-android-entry-points.md): an
 * intent carrying a bootstrap URL reaches [Cordierite], and therefore the underlying
 * [CordieriteClient], via [CordieriteLinkActivity.onCreate]. Uses a real `android.jar` (via
 * Robolectric, already a test dependency for [CordieriteSpkiPinTest]) rather than
 * [FakeCordieriteTransport] alone, since this is the one behavior that needs a real `Activity`
 * lifecycle to exercise.
 */
@RunWith(RobolectricTestRunner::class)
class CordieriteLinkActivityTest {
    private lateinit var client: CordieriteClient
    private lateinit var fake: FakeCordieriteTransport

    @Before
    fun setUp() {
        lateinit var transport: FakeCordieriteTransport
        client =
            CordieriteClient(
                transportFactory = { _, onMessage, onError, onClose ->
                    FakeCordieriteTransport(onMessage, onError, onClose).also { transport = it }
                },
            )
        fake = transport
        Cordierite.attachForTest(client)
    }

    @After
    fun tearDown() {
        Cordierite.detachForTest()
    }

    @Test
    fun `an intent with a bootstrap URL reaches the client`() {
        val events = mutableListOf<CordieriteEvent>()
        val subscription = Cordierite.addListener { events.add(it) }

        val intent =
            Intent(
                Intent.ACTION_VIEW,
                Uri.parse("cordierite-core-test://bootstrap?cordierite=not-a-real-payload"),
            )

        Robolectric.buildActivity(CordieriteLinkActivity::class.java, intent).create()

        // The payload above is not a real v2 bootstrap blob, so the client cannot claim a
        // session from it -- but reaching `handleUrl` at all (rather than the activity silently
        // dropping the intent) is exactly what this test is for, and it surfaces as a "bootstrap"
        // phase error on the very same listener a real app would use.
        waitUntil {
            events.any { it is CordieriteEvent.Error && it.phase == "bootstrap" }
        }
        assertTrue(events.any { it is CordieriteEvent.Error && it.phase == "bootstrap" })

        subscription.remove()
    }

    @Test
    fun `an intent with no cordierite payload does not reach the client`() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("cordierite-core-test://bootstrap?nothing=here"))

        val controller = Robolectric.buildActivity(CordieriteLinkActivity::class.java, intent).create()

        // No exception, no crash, and the activity finishes regardless -- `handle` returning
        // `false` here is a documented limitation (see CordieriteLinkActivity's doc comment), not
        // something this activity forwards anywhere.
        assertTrue(controller.get().isFinishing)
    }
}
