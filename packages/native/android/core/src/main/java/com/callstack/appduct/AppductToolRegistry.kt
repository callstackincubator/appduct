package com.callstack.appduct

import org.json.JSONObject

private val TOOL_NAME_PATTERN = Regex("^[a-zA-Z0-9_-]{1,64}$")

/** Mirrors `@appduct/shared`'s `TOOL_GROUP_PATTERN`: one or two `/`-separated tool-name segments.
 * `Regex.matches` is a whole-string match, like JS's anchored `RegExp.test`. */
private val TOOL_GROUP_PATTERN = Regex("^[a-zA-Z0-9_-]{1,64}(?:/[a-zA-Z0-9_-]{1,64})?$")

/** Whether [group] is a valid tool group (PROTOCOL.md §5) -- `@appduct/shared`'s `isValidToolGroup`. */
internal fun isValidAppductToolGroup(group: String): Boolean = TOOL_GROUP_PATTERN.matches(group)
private const val MAX_TOOL_DESCRIPTION_LENGTH = 4096
private val TOOL_ANNOTATION_KEYS = setOf("readOnlyHint", "destructiveHint", "idempotentHint")

/**
 * Validates a [AppductToolDescriptor] against PROTOCOL.md §5, the same rules
 * `@appduct/shared`'s `isToolDescriptor` applies: `name` matches `^[a-zA-Z0-9_-]{1,64}$`,
 * `description` is 1-4096 chars, `annotations` (if present) is a JSON object of only the three
 * known boolean keys, `timeoutMs` (if present) is a positive integer, and `group` (if present) is
 * one or two `/`-separated segments each matching the name pattern. `inputSchema`/
 * `outputSchema` are typed as `JSONObject?` already, so "JSON object if present" is guaranteed
 * structurally and needs no runtime check here.
 *
 * Throws [AppductInvalidToolDescriptorException] (an `IllegalArgumentException`) naming the
 * first violation found, rather than returning a boolean -- `registerTool` is documented to throw.
 */
internal fun validateAppductToolDescriptor(descriptor: AppductToolDescriptor) {
    if (!TOOL_NAME_PATTERN.matches(descriptor.name)) {
        throw AppductInvalidToolDescriptorException(
            "Tool name \"${descriptor.name}\" must match ^[a-zA-Z0-9_-]{1,64}$.",
        )
    }

    if (descriptor.description.isEmpty() || descriptor.description.length > MAX_TOOL_DESCRIPTION_LENGTH) {
        throw AppductInvalidToolDescriptorException(
            "Tool \"${descriptor.name}\" description must be 1-$MAX_TOOL_DESCRIPTION_LENGTH characters.",
        )
    }

    val annotations = descriptor.annotations
    if (annotations != null) {
        val keys = annotations.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in TOOL_ANNOTATION_KEYS) {
                throw AppductInvalidToolDescriptorException(
                    "Tool \"${descriptor.name}\" annotations has unknown key \"$key\".",
                )
            }
            val value = annotations.opt(key)
            if (value !is Boolean) {
                throw AppductInvalidToolDescriptorException(
                    "Tool \"${descriptor.name}\" annotations.$key must be a boolean.",
                )
            }
        }
    }

    val timeoutMs = descriptor.timeoutMs
    if (timeoutMs != null && timeoutMs <= 0) {
        throw AppductInvalidToolDescriptorException(
            "Tool \"${descriptor.name}\" timeoutMs must be a positive integer.",
        )
    }

    val group = descriptor.group
    if (group != null && !isValidAppductToolGroup(group)) {
        throw AppductInvalidToolDescriptorException(
            "Tool \"${descriptor.name}\" group \"$group\" must be one or two \"/\"-separated segments, each matching ^[a-zA-Z0-9_-]{1,64}$.",
        )
    }
}

internal sealed class AppductRegistryDelta {
    data class Upsert(val descriptor: AppductToolDescriptor) : AppductRegistryDelta()

    data class Remove(val name: String) : AppductRegistryDelta()
}

/**
 * Tool registration table: upsert by name, registration order preserved (a `LinkedHashMap` keeps
 * an existing key's position when re-`put`, only insertion/removal changes ordering -- so
 * re-registering an existing tool by name does not move it to the end). Not thread-safe by itself;
 * [AppductClient] confines every mutation to its own single-threaded dispatcher.
 */
internal class AppductToolRegistry {
    private val lock = Any()
    private val entries = LinkedHashMap<String, AppductRegisteredTool>()

    /** `registerTool`/`unregisterTool` are ordinary (non-suspend) calls an app may make from any
     * thread, unlike the rest of [AppductClient]'s state, which is confined to its own
     * dispatcher -- so registry mutation is synchronized here instead. A declared `timeoutMs` is
     * clamped to `[APPDUCT_MIN_TOOL_TIMEOUT_MS, APPDUCT_MAX_TOOL_TIMEOUT_MS]` before it is
     * stored, so the clamped value is what both the local timeout and the returned (stored)
     * descriptor's wire delta use. */
    fun upsert(
        descriptor: AppductToolDescriptor,
        handler: AppductToolHandler,
    ): AppductRegistryDelta {
        validateAppductToolDescriptor(descriptor)
        val effectiveDescriptor =
            descriptor.timeoutMs?.let { descriptor.copy(timeoutMs = clampAppductToolTimeoutMs(it)) } ?: descriptor
        synchronized(lock) {
            entries[effectiveDescriptor.name] = AppductRegisteredTool(effectiveDescriptor, handler)
        }
        return AppductRegistryDelta.Upsert(effectiveDescriptor)
    }

    /** Returns the removal delta, or `null` when `name` was not registered (a no-op, matching
     * `registry.ts`'s `unregisterTool`). */
    fun remove(name: String): AppductRegistryDelta.Remove? {
        val removed = synchronized(lock) { entries.remove(name) }
        if (removed == null) return null
        return AppductRegistryDelta.Remove(name)
    }

    fun get(name: String): AppductRegisteredTool? = synchronized(lock) { entries[name] }

    /** Registered descriptors, in registration order. */
    fun descriptors(): List<AppductToolDescriptor> = synchronized(lock) { entries.values.map { it.descriptor } }

    internal fun snapshotWireJson(): List<JSONObject> = synchronized(lock) { entries.values.map { it.descriptor.toWireJson() } }
}
