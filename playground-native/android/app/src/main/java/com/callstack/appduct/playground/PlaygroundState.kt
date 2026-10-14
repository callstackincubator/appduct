package com.callstack.appduct.playground

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import com.callstack.appduct.ClientState

/**
 * In-memory, Compose-observable mirror of what the [com.callstack.appduct.Appduct]
 * facade reports -- connection state, session id, and a capped log of recent events/tool calls --
 * so [MainActivity]'s UI updates live without owning a listener itself. Written from
 * [PlaygroundApplication]'s single [com.callstack.appduct.Appduct.addListener]
 * subscription and from the registered tool handlers; read from Composables.
 */
object PlaygroundState {
    enum class Screen { Tools, Status }

    var clientState by mutableStateOf(ClientState.idle)
        internal set

    var sessionId by mutableStateOf<String?>(null)
        internal set

    var callCount by mutableStateOf(0)
        internal set

    /** The `at` of the last `playground_ping` this app sent. */
    var lastPing by mutableStateOf<Long?>(null)
        internal set

    var screen by mutableStateOf(Screen.Tools)

    val recentEvents: SnapshotStateList<String> = mutableStateListOf()

    private const val MAX_EVENTS = 50

    /** Prepends [line] to [recentEvents] (newest first) and trims to [MAX_EVENTS]. */
    fun logEvent(line: String) {
        recentEvents.add(0, line)
        while (recentEvents.size > MAX_EVENTS) {
            recentEvents.removeAt(recentEvents.lastIndex)
        }
    }
}
