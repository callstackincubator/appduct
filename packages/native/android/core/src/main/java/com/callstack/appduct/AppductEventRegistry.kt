package com.callstack.appduct

import org.json.JSONObject

private const val MAX_EVENT_NAME_LENGTH = 4096
private const val MAX_EVENT_DESCRIPTION_LENGTH = 4096

/**
 * Validates an [AppductEventDescriptor] against PROTOCOL.md §5a, like `@appduct/shared`'s
 * `isEventDescriptor`: `name` is any string of 1-4096 UTF-16 code units (Kotlin's `String.length`,
 * so 2048 non-BMP characters fit and 2049 do not), `description` is 1-4096 characters, and
 * `payloadSchema` is a JSON object by type. Throws [AppductInvalidEventDescriptorException].
 */
internal fun validateAppductEventDescriptor(descriptor: AppductEventDescriptor) {
    if (descriptor.name.isEmpty() || descriptor.name.length > MAX_EVENT_NAME_LENGTH) {
        throw AppductInvalidEventDescriptorException("Event name must be 1-$MAX_EVENT_NAME_LENGTH characters.")
    }
    if (descriptor.description.isEmpty() || descriptor.description.length > MAX_EVENT_DESCRIPTION_LENGTH) {
        throw AppductInvalidEventDescriptorException(
            "Event \"${descriptor.name.take(64)}\" description must be 1-$MAX_EVENT_DESCRIPTION_LENGTH characters.",
        )
    }
}

/** Declared events: upsert by name, declaration order preserved (a re-declaration keeps its
 * position). Thread-safe, because `registerEvent` may be called from any thread. */
internal class AppductEventRegistry {
    private val lock = Any()
    private val entries = LinkedHashMap<String, AppductEventDescriptor>()

    fun upsert(descriptor: AppductEventDescriptor) {
        validateAppductEventDescriptor(descriptor)
        synchronized(lock) { entries[descriptor.name] = descriptor }
    }

    /** Whether [name] was declared. */
    fun remove(name: String): Boolean = synchronized(lock) { entries.remove(name) != null }

    fun snapshotWireJson(): List<JSONObject> = synchronized(lock) { entries.values.map { it.toWireJson() } }
}
