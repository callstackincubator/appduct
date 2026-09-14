package com.callstackincubator.cordierite

private const val MAX_WIRE_ID_LENGTH = 128
private const val MAX_WIRE_STRING_LENGTH = 4096

/** Process-memory recovery data owned by [CordieriteConnectionManager] /
 * [CordieriteProcessResumeLeaseStore]. Parsed view of the `Map<String, Any?>` returned by
 * [CordieriteTransport.getResumeLeaseRecord] -- port of `client/resume-lease.ts`'s `ResumeLeaseV1`. */
internal data class CordieriteParsedResumeLease(
    val sessionId: String,
    val resumeToken: String,
    val alias: String,
    val ip: String,
    val port: Int,
    val keepaliveIntervalS: Double,
    val graceS: Double,
    val disconnectedAtMs: Long?,
)

private fun isBoundedNonEmptyString(
    value: Any?,
    maxLength: Int,
): Boolean = value is String && value.isNotEmpty() && value.length <= maxLength

private fun isValidPort(value: Any?): Boolean = value is Int && value in 1..65535

/**
 * Validates and parses a raw resume-lease record (as returned by the transport) the same way
 * `resume-lease.ts`'s `parseResumeLease` validates the native lease it receives over the bridge --
 * defense in depth even though this record is produced by trusted in-process code, not external
 * input.
 */
internal fun parseCordieriteResumeLease(record: Map<String, Any?>?): CordieriteParsedResumeLease? {
    if (record == null) return null

    val endpoint = record["endpoint"] as? Map<*, *> ?: return null
    val schemaVersion = record["schemaVersion"]
    val sessionId = record["sessionId"]
    val resumeToken = record["resumeToken"]
    val alias = record["alias"]
    val ip = endpoint["ip"]
    val port = endpoint["port"]
    val keepaliveIntervalS = (record["keepaliveIntervalS"] as? Number)?.toDouble()
    val graceS = (record["graceS"] as? Number)?.toDouble()
    val disconnectedAtMsRaw = record["disconnectedAtMs"]

    if (schemaVersion != 1) return null
    if (!isBoundedNonEmptyString(sessionId, MAX_WIRE_ID_LENGTH)) return null
    if (!isBoundedNonEmptyString(resumeToken, MAX_WIRE_ID_LENGTH)) return null
    if (!isBoundedNonEmptyString(alias, MAX_WIRE_ID_LENGTH)) return null
    if (!isBoundedNonEmptyString(ip, MAX_WIRE_STRING_LENGTH)) return null
    if (!isValidPort(port)) return null
    if (keepaliveIntervalS == null || !keepaliveIntervalS.isFinite() || keepaliveIntervalS <= 0.0) return null
    if (graceS == null || !graceS.isFinite() || graceS <= 0.0) return null

    val disconnectedAtMs: Long? =
        when (disconnectedAtMsRaw) {
            null -> null
            is Number -> {
                val v = disconnectedAtMsRaw.toDouble()
                if (!v.isFinite() || v < 0.0) return null
                disconnectedAtMsRaw.toLong()
            }
            else -> return null
        }

    return CordieriteParsedResumeLease(
        sessionId = sessionId as String,
        resumeToken = resumeToken as String,
        alias = alias as String,
        ip = ip as String,
        port = port as Int,
        keepaliveIntervalS = keepaliveIntervalS,
        graceS = graceS,
        disconnectedAtMs = disconnectedAtMs,
    )
}

/** Port of `resume-lease.ts`'s `isResumeLeaseExpired`. */
internal fun isCordieriteResumeLeaseExpired(
    lease: CordieriteParsedResumeLease,
    nowMs: Long,
): Boolean = lease.disconnectedAtMs != null && nowMs - lease.disconnectedAtMs >= (lease.graceS * 1000).toLong()
