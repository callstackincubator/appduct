package com.callstackincubator.cordierite

import org.json.JSONObject

private val TOOL_NAME_PATTERN = Regex("^[a-zA-Z0-9_-]{1,64}$")
private const val MAX_TOOL_DESCRIPTION_LENGTH = 4096
private val TOOL_ANNOTATION_KEYS = setOf("readOnlyHint", "destructiveHint", "idempotentHint")

/**
 * Validates a [CordieriteToolDescriptor] against PROTOCOL.md §5, the same rules
 * `@cordierite/shared`'s `isToolDescriptor` applies: `name` matches `^[a-zA-Z0-9_-]{1,64}$`,
 * `description` is 1-4096 chars, `annotations` (if present) is a JSON object of only the three
 * known boolean keys, and `timeoutMs` (if present) is a positive integer. `inputSchema`/
 * `outputSchema` are typed as `JSONObject?` already, so "JSON object if present" is guaranteed
 * structurally and needs no runtime check here.
 *
 * Throws [CordieriteInvalidToolDescriptorException] (an `IllegalArgumentException`) naming the
 * first violation found, rather than returning a boolean -- `registerTool` is documented to throw.
 */
internal fun validateCordieriteToolDescriptor(descriptor: CordieriteToolDescriptor) {
    if (!TOOL_NAME_PATTERN.matches(descriptor.name)) {
        throw CordieriteInvalidToolDescriptorException(
            "Tool name \"${descriptor.name}\" must match ^[a-zA-Z0-9_-]{1,64}$.",
        )
    }

    if (descriptor.description.isEmpty() || descriptor.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
        throw CordieriteInvalidToolDescriptorException(
            "Tool \"${descriptor.name}\" description must be 1-$MAX_TOOL_DESCRIPTION_LENGTH characters.",
        )
    }

    val annotations = descriptor.annotations
    if (annotations != null) {
        val keys = annotations.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in TOOL_ANNOTATION_KEYS) {
                throw CordieriteInvalidToolDescriptorException(
                    "Tool \"${descriptor.name}\" annotations has unknown key \"$key\".",
                )
            }
            val value = annotations.opt(key)
            if (value !is Boolean) {
                throw CordieriteInvalidToolDescriptorException(
                    "Tool \"${descriptor.name}\" annotations.$key must be a boolean.",
                )
            }
        }
    }

    val timeoutMs = descriptor.timeoutMs
    if (timeoutMs != null && timeoutMs <= 0) {
        throw CordieriteInvalidToolDescriptorException(
            "Tool \"${descriptor.name}\" timeoutMs must be a positive integer.",
        )
    }
}

internal sealed class CordieriteRegistryDelta {
    data class Upsert(val descriptor: CordieriteToolDescriptor) : CordieriteRegistryDelta()

    data class Remove(val name: String) : CordieriteRegistryDelta()
}

/**
 * Tool registration table: upsert by name, registration order preserved (a `LinkedHashMap` keeps
 * an existing key's position when re-`put`, only insertion/removal changes ordering -- so
 * re-registering an existing tool by name does not move it to the end). Not thread-safe by itself;
 * [CordieriteClient] confines every mutation to its own single-threaded dispatcher.
 */
internal class CordieriteToolRegistry {
    private val lock = Any()
    private val entries = LinkedHashMap<String, CordieriteRegisteredTool>()

    /** `registerTool`/`unregisterTool` are ordinary (non-suspend) calls an app may make from any
     * thread, unlike the rest of [CordieriteClient]'s state, which is confined to its own
     * dispatcher -- so registry mutation is synchronized here instead. */
    fun upsert(
        descriptor: CordieriteToolDescriptor,
        handler: CordieriteToolHandler,
    ): CordieriteRegistryDelta {
        validateCordieriteToolDescriptor(descriptor)
        synchronized(lock) {
            entries[descriptor.name] = CordieriteRegisteredTool(descriptor, handler)
        }
        return CordieriteRegistryDelta.Upsert(descriptor)
    }

    /** Returns the removal delta, or `null` when `name` was not registered (a no-op, matching
     * `registry.ts`'s `unregisterTool`). */
    fun remove(name: String): CordieriteRegistryDelta.Remove? {
        val removed = synchronized(lock) { entries.remove(name) }
        if (removed == null) return null
        return CordieriteRegistryDelta.Remove(name)
    }

    fun get(name: String): CordieriteRegisteredTool? = synchronized(lock) { entries[name] }

    /** Registered descriptors, in registration order. */
    fun descriptors(): List<CordieriteToolDescriptor> = synchronized(lock) { entries.values.map { it.descriptor } }

    internal fun snapshotWireJson(): List<JSONObject> = synchronized(lock) { entries.values.map { it.descriptor.toWireJson() } }
}
