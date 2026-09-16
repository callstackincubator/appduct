package com.callstack.appduct

import kotlin.random.Random

/** Reconnect backoff bounds (ARCHITECTURE.md §11): 0.5 s floor, 30 s cap, full jitter. Exact
 * port of `client/backoff.ts`'s constants -- the daemon and app must agree on this shape, but
 * nothing on the wire depends on the client's actual retry timing, so these only need to match the
 * JS client's own behavior for parity, not the protocol. */
internal const val APPDUCT_BACKOFF_BASE_MS = 500L
internal const val APPDUCT_BACKOFF_CAP_MS = 30_000L

/**
 * AWS-style "full jitter": `random(0, min(cap, base * 2^attempt))`. `attempt` is 0-based (the
 * first retry after a loss). Injectable `random` keeps the schedule deterministic in tests -- port
 * of `client/backoff.ts`'s `computeFullJitterBackoffMs`.
 */
internal fun computeAppductFullJitterBackoffMs(
    attempt: Int,
    baseMs: Long = APPDUCT_BACKOFF_BASE_MS,
    capMs: Long = APPDUCT_BACKOFF_CAP_MS,
    random: () -> Double = { Random.nextDouble() },
): Long {
    val upperBound = minOf(capMs, (baseMs * Math.pow(2.0, maxOf(attempt, 0).toDouble())).toLong())
    return (random() * upperBound).toLong()
}
