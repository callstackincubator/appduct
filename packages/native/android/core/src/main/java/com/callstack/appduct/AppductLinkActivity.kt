package com.callstack.appduct

import android.app.Activity
import android.os.Bundle

/**
 * No-UI trampoline for `${appductScheme}://` deep links (docs/tasks/19-android-entry-points.md).
 * Declared only in this module's own `AndroidManifest.xml` -- never vendored into
 * `@appduct/react-native` (`scripts/sync-native-core.mjs` copies the `src/main/java` tree only, never
 * a manifest), so the RN bridge, which handles its own deep links via `handleUrl`/`Linking`, never
 * gets this activity registered and is unaffected by anything below.
 *
 * Forwards to [Appduct.handle] and finishes immediately, whatever the outcome. A link that
 * carried no Appduct payload is *not* forwarded anywhere else: this activity has no notion of
 * where the app's own deep-link destination is, and finishing (`noHistory`, `excludeFromRecents`)
 * is all it can do. An app that wants both its own scheme handling and Appduct must either
 * give Appduct a dedicated scheme -- the `manifestPlaceholders["appductScheme"]` value an
 * app sets can differ from its own primary deep-link scheme -- or forward from its own activity
 * instead, by calling `Appduct.handle(intent)` itself and removing this activity entirely
 * (`tools:node="remove"`; see `packages/native/android/README.md`).
 */
class AppductLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        intent?.let { Appduct.handle(it) }
        finish()
    }
}
