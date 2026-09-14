package com.callstackincubator.cordierite

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri

/**
 * Dependency-free `ContentProvider` that exists for exactly one reason: to hand [Cordierite] an
 * application `Context` before any app code runs. The platform instantiates every
 * manifest-declared `ContentProvider` and calls its [onCreate] during process startup, strictly
 * before `Application.onCreate()` -- so by the time an app's own `Application.onCreate()` calls
 * `Cordierite.register(...)`, this has already run and [Cordierite] has a client to register
 * against.
 *
 * Declared in this module's own `AndroidManifest.xml` with
 * `android:authorities="${applicationId}.cordierite-init"` (per-app unique, as the platform
 * requires for a `ContentProvider` authority) and `android:exported="false"` (never queried
 * cross-process). See `packages/native/android/README.md` for the `tools:node="remove"` opt-out
 * and what an app that removes it must do instead (call `Cordierite.attach`-equivalent
 * initialization is not exposed publicly; removing this provider means driving `Cordierite`
 * entirely without automatic init, which today means not using the `Cordierite` facade at all).
 *
 * Not vendored into `@cordierite/react-native` -- that package's
 * `scripts/sync-native-core.mjs` copies only the `src/main/java` tree, never `AndroidManifest.xml` --
 * so although this class compiles into the RN bridge's AAR too (nothing excludes the source file
 * itself from that copy), it is never actually registered there. The RN bridge talks to
 * `CordieriteClient` directly and has its own initialization path
 * (`NativeCordieriteModule`'s constructor).
 */
class CordieriteInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        val appContext = context?.applicationContext ?: return false
        Cordierite.attach(appContext)
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<String>?,
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(
        uri: Uri,
        values: ContentValues?,
    ): Uri? = null

    override fun delete(
        uri: Uri,
        selection: String?,
        selectionArgs: Array<String>?,
    ): Int = 0

    override fun update(
        uri: Uri,
        values: ContentValues?,
        selection: String?,
        selectionArgs: Array<String>?,
    ): Int = 0
}
