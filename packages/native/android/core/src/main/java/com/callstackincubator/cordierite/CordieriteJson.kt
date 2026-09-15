package com.callstackincubator.cordierite

import org.json.JSONArray
import org.json.JSONObject

/**
 * Recursively converts a Kotlin/Java value returned from a [CordieriteToolHandler] into a
 * JSON-ready value (`JSONObject`/`JSONArray`/`String`/`Number`/`Boolean`/`JSONObject.NULL`),
 * mirroring what `JSON.stringify` accepts on the JS side (`tool-invocation.ts`'s
 * `JSON.stringify(parsedResult.value)` probe). Throws [IllegalArgumentException] for anything that
 * cannot be represented -- the caller reports that as `tool_serialization_error`.
 */
internal fun cordieriteToJsonValue(value: Any?): Any =
    when (value) {
        null -> JSONObject.NULL
        is JSONObject, is JSONArray -> value
        is String, is Boolean -> value
        is Int, is Long, is Short, is Byte -> value
        is Double -> {
            if (!value.isFinite()) {
                throw IllegalArgumentException("Cordierite tool result contains a non-finite number ($value).")
            }
            value
        }
        is Float -> cordieriteToJsonValue(value.toDouble())
        is Map<*, *> -> {
            val out = JSONObject()
            for ((k, v) in value) {
                if (k !is String) {
                    throw IllegalArgumentException("Cordierite tool result map keys must be strings.")
                }
                out.put(k, cordieriteToJsonValue(v))
            }
            out
        }
        is List<*> -> {
            val out = JSONArray()
            for (v in value) out.put(cordieriteToJsonValue(v))
            out
        }
        is Array<*> -> cordieriteToJsonValue(value.toList())
        else ->
            throw IllegalArgumentException(
                "Cordierite tool result of type ${value::class.java.name} is not JSON-serializable.",
            )
    }
