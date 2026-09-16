package com.callstack.appduct

/**
 * RFC 6455 "policy violation". Every daemon-side rejection that a `session_resume` (or
 * `session_claim`) can never talk its way out of closes with this code (PROTOCOL.md §7):
 * `unknown_session`, `invalid_resume_token`, `link_expired`, `already_claimed`,
 * `claim_attempts_exceeded`, `invalid_token`, `invalid_message`, `invalid_registry`,
 * `unknown_message_type`. Retrying an identical frame against any of them can only fail the same
 * way, so 1008 is treated as terminal wholesale rather than by matching individual reason strings.
 *
 * Deliberately *not* terminal: 1011 (`send_failed`) and 1001 (`daemon_shutdown`) are
 * transport-level and genuinely worth retrying inside the grace window, as is 1006 (abnormal
 * close -- backgrounding, network blips). Port of `client/terminal-close.ts`.
 */
internal const val APPDUCT_POLICY_VIOLATION_CLOSE_CODE = 1000 + 8

/** Whether the daemon closed with a rejection that no retry of the same frame could ever satisfy. */
internal fun isAppductTerminalCloseCode(code: Int?): Boolean = code == APPDUCT_POLICY_VIOLATION_CLOSE_CODE

/** The `sessionChange`-lost reason to report for a terminal close -- the daemon's own wire reason
 * when it sent one. */
internal fun appductTerminalCloseReason(reason: String?): String = reason ?: "rejected_by_daemon"
