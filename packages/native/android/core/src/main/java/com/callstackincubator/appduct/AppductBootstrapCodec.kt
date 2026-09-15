package com.callstackincubator.appduct

import java.io.UnsupportedEncodingException
import java.net.URLDecoder
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/** Bootstrap payload version byte (PROTOCOL.md §2). The v1 version byte is never accepted. */
private const val BOOTSTRAP_VERSION_V2 = 0x02
private const val FAMILY_IPV4 = 0x04
private const val FAMILY_IPV6 = 0x06
private const val TOKEN_BYTES = 32
private const val EXPIRES_AT_BYTES = 8

/** A decoded v2 bootstrap payload (PROTOCOL.md §2). Port of `@appduct/shared`'s `BootstrapPayload`. */
internal data class AppductBootstrapPayload(
    /** 4 (IPv4) or 6 (IPv6). */
    val family: Int,
    /** `"192.168.1.10"` for family 4, `"fd00::1"` for family 6 (no brackets, no zone id). */
    val address: String,
    val port: Int,
    val sessionId: String,
    /** Base64url (no padding) encoding of the 32 raw token bytes. */
    val token: String,
    /** Unix seconds. */
    val expiresAt: Long,
)

private fun decodeBase64UrlToBytes(input: String): ByteArray? {
    if (input.isEmpty()) return null
    return try {
        val normalized = input.replace('-', '+').replace('_', '/')
        val pad = (4 - normalized.length % 4) % 4
        android.util.Base64.decode(normalized + "=".repeat(pad), android.util.Base64.DEFAULT)
    } catch (_: Throwable) {
        null
    }
}

private fun encodeBytesToBase64Url(bytes: ByteArray): String =
    android.util.Base64.encodeToString(
        bytes,
        android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING or android.util.Base64.URL_SAFE,
    )

private fun bytesToIpv4String(bytes: ByteArray): String =
    "${bytes[0].toInt() and 0xff}.${bytes[1].toInt() and 0xff}.${bytes[2].toInt() and 0xff}.${bytes[3].toInt() and 0xff}"

private fun bytesToIpv6String(bytes: ByteArray): String {
    val groups = IntArray(8) { i -> ((bytes[i * 2].toInt() and 0xff) shl 8) or (bytes[i * 2 + 1].toInt() and 0xff) }

    var bestStart = -1
    var bestLen = 0
    var runStart = -1
    for (i in 0..groups.size) {
        val isZero = i < groups.size && groups[i] == 0
        if (isZero) {
            if (runStart == -1) runStart = i
        } else if (runStart != -1) {
            val runLen = i - runStart
            if (runLen > bestLen) {
                bestLen = runLen
                bestStart = runStart
            }
            runStart = -1
        }
    }

    if (bestLen < 2) {
        return groups.joinToString(":") { it.toString(16) }
    }

    val before = groups.copyOfRange(0, bestStart).joinToString(":") { it.toString(16) }
    val after = groups.copyOfRange(bestStart + bestLen, groups.size).joinToString(":") { it.toString(16) }
    return "$before::$after"
}

private fun bytesToAddress(
    family: Int,
    bytes: ByteArray,
): String = if (family == FAMILY_IPV4) bytesToIpv4String(bytes) else bytesToIpv6String(bytes)

private fun readU16BE(
    bytes: ByteArray,
    offset: Int,
): Int = ((bytes[offset].toInt() and 0xff) shl 8) or (bytes[offset + 1].toInt() and 0xff)

private fun readU64BESeconds(
    bytes: ByteArray,
    offset: Int,
): Long {
    var value = 0L
    for (i in 0 until 8) {
        value = (value shl 8) or (bytes[offset + i].toLong() and 0xff)
    }
    return value
}

private fun isValidPort(value: Int): Boolean = value in 1..65535

/**
 * Decodes and strictly validates a base64url bootstrap payload (PROTOCOL.md §2). Rejects: wrong
 * version (including v1's version byte, with no fallback), a bad family byte, a truncated or
 * oversized buffer (exact total-length check), a non-UTF-8 or zero-length session id, and port
 * `0`. Port of `@appduct/shared`'s `decodeBootstrap`.
 */
internal fun decodeAppductBootstrap(base64Url: String): AppductBootstrapPayload? {
    val bytes = decodeBase64UrlToBytes(base64Url) ?: return null
    if (bytes.size < 2) return null
    if (bytes[0].toInt() != BOOTSTRAP_VERSION_V2) return null

    val familyByte = bytes[1].toInt() and 0xff
    if (familyByte != FAMILY_IPV4 && familyByte != FAMILY_IPV6) return null

    val family = if (familyByte == FAMILY_IPV4) 4 else 6
    val addressLen = if (family == 4) 4 else 16
    val headerLen = 1 + 1 + addressLen + 2

    if (bytes.size < headerLen + 1) return null

    var offset = 2
    val addressBytes = bytes.copyOfRange(offset, offset + addressLen)
    offset += addressLen

    val port = readU16BE(bytes, offset)
    offset += 2

    if (bytes.size <= offset) return null

    val sessionIdLen = bytes[offset].toInt() and 0xff
    offset += 1

    val totalLen = offset + sessionIdLen + TOKEN_BYTES + EXPIRES_AT_BYTES
    if (sessionIdLen == 0 || bytes.size != totalLen) return null

    val sessionIdBytes = bytes.copyOfRange(offset, offset + sessionIdLen)
    offset += sessionIdLen

    val tokenBytes = bytes.copyOfRange(offset, offset + TOKEN_BYTES)
    offset += TOKEN_BYTES

    val expiresAt = readU64BESeconds(bytes, offset)

    if (!isValidPort(port)) return null

    val sessionId =
        try {
            val decoder =
                StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
            decoder.decode(java.nio.ByteBuffer.wrap(sessionIdBytes)).toString()
        } catch (_: CharacterCodingException) {
            return null
        }

    return AppductBootstrapPayload(
        family = family,
        address = bytesToAddress(family, addressBytes),
        port = port,
        sessionId = sessionId,
        token = encodeBytesToBase64Url(tokenBytes),
        expiresAt = expiresAt,
    )
}

/** `sha256/` + 44 base64 chars (32-byte digest, standard alphabet incl. padding) -- the exact
 * shape `createSpkiPin` produces. Anything else is treated as absent, mirroring `bootstrap.ts`'s
 * `extractLinkPin`. */
private val LINK_PIN_PATTERN = Regex("^sha256/[A-Za-z0-9+/]{43}=$")

/**
 * Splits a query string into raw (not yet URL-decoded) `key -> value` pairs, stopping at the
 * first `#` fragment. No `android.net.Uri`/`java.net.URL` dependency, so this is unit-testable on
 * the plain JVM (no Robolectric): manual, minimal query-string parsing mirroring what `new
 * URL(rawUrl).searchParams` does for the two params Appduct cares about. Anything reading the
 * `appduct` payload must stop at the first `&` -- naive slicing to end-of-string would swallow
 * a following `pin` param.
 */
private fun parseQueryParams(url: String): Map<String, String> {
    val queryStart = url.indexOf('?')
    if (queryStart == -1) return emptyMap()

    var query = url.substring(queryStart + 1)
    val fragmentStart = query.indexOf('#')
    if (fragmentStart != -1) {
        query = query.substring(0, fragmentStart)
    }

    if (query.isEmpty()) return emptyMap()

    val out = LinkedHashMap<String, String>()
    for (pair in query.split('&')) {
        if (pair.isEmpty()) continue
        val eq = pair.indexOf('=')
        val rawKey = if (eq == -1) pair else pair.substring(0, eq)
        val rawValue = if (eq == -1) "" else pair.substring(eq + 1)
        val key =
            try {
                URLDecoder.decode(rawKey, "UTF-8")
            } catch (_: UnsupportedEncodingException) {
                rawKey
            }
        // First occurrence wins, matching URLSearchParams#get.
        if (!out.containsKey(key)) {
            val value =
                try {
                    URLDecoder.decode(rawValue, "UTF-8")
                } catch (_: UnsupportedEncodingException) {
                    rawValue
                } catch (_: IllegalArgumentException) {
                    rawValue
                }
            out[key] = value
        }
    }
    return out
}

/** True iff `rawUrl` includes a `appduct` query parameter -- mirrors `deep-link-core.ts`'s
 * `hasAppductBootstrapQuery`. Does not itself decode or validate the payload. */
internal fun hasAppductBootstrapQuery(rawUrl: String?): Boolean {
    if (rawUrl.isNullOrEmpty()) return false
    return parseQueryParams(rawUrl).containsKey("appduct")
}

internal data class ParsedBootstrapUrl(
    val payload: AppductBootstrapPayload,
    val linkPin: String?,
)

internal sealed class BootstrapUrlParseError(message: String) : Exception(message) {
    class MissingPayload : BootstrapUrlParseError("Bootstrap URL is missing the appduct query parameter.")

    class InvalidPayload :
        BootstrapUrlParseError(
            "Bootstrap payload must be a valid base64url-encoded v2 bootstrap blob (see docs/PROTOCOL.md).",
        )

    class ExpiredPayload : BootstrapUrlParseError("Bootstrap payload has expired.")
}

/** `expiresAt`, in unix seconds, is expired once it is `<= now` (matches `isExpiredAt`). */
internal fun isAppductBootstrapExpired(
    expiresAt: Long,
    nowSeconds: Long,
): Boolean = expiresAt <= nowSeconds

/**
 * Parses and validates an Appduct bootstrap deep link (PROTOCOL.md §2, `bootstrap.ts`'s
 * `parseBootstrapUrl`): the `appduct` query param decodes to a valid, unexpired v2 payload,
 * and (when [requirePrivateIp]) the advertised address is local/private. The `pin` param, when
 * present and well-formed, is returned as [ParsedBootstrapUrl.linkPin].
 */
internal fun parseAppductBootstrapUrl(
    rawUrl: String,
    nowSeconds: Long,
    requirePrivateIp: Boolean,
): ParsedBootstrapUrl {
    val params = parseQueryParams(rawUrl)
    val rawPayload = params["appduct"] ?: throw BootstrapUrlParseError.MissingPayload()

    val decoded = decodeAppductBootstrap(rawPayload) ?: throw BootstrapUrlParseError.InvalidPayload()

    if (isAppductBootstrapExpired(decoded.expiresAt, nowSeconds)) {
        throw BootstrapUrlParseError.ExpiredPayload()
    }

    if (requirePrivateIp && !isAppductLocalAddress(decoded.family, decoded.address)) {
        throw BootstrapUrlParseError.InvalidPayload()
    }

    val rawPin = params["pin"]
    val linkPin = if (rawPin != null && LINK_PIN_PATTERN.matches(rawPin)) rawPin else null

    return ParsedBootstrapUrl(decoded, linkPin)
}

/** Port of `@appduct/shared`'s `isLocalAddress`: loopback/RFC1918 for IPv4, loopback/ULA/link-local
 * for IPv6. */
internal fun isAppductLocalAddress(
    family: Int,
    address: String,
): Boolean = if (family == 4) isLocalIpv4Address(address) else isAppductLocalIpv6Address(address)

private fun isAppductLocalIpv6Address(value: String): Boolean {
    if (value == "::1") return true
    val normalized = value.lowercase()
    if (Regex("^f[cd][0-9a-f]{2}:").containsMatchIn(normalized)) return true
    return Regex("^fe80:", RegexOption.IGNORE_CASE).containsMatchIn(value)
}
