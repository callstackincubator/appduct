package com.callstackincubator.cordierite.playground

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.callstackincubator.cordierite.Cordierite
import kotlinx.coroutines.launch

/**
 * The playground's one screen: current connection state/session, a button that posts an app
 * event, and a log of recent state/session/error events and tool calls -- the native mirror of
 * the Expo playground's `playground/app/(tabs)/index.tsx` (docs/tasks/19-android-entry-points.md).
 * Deep links never reach here directly: `CordieriteLinkActivity` (declared in `core`'s manifest)
 * is the exported entry point for `cordierite-native://` links, and this activity's UI just
 * reflects [PlaygroundState], which [PlaygroundApplication] keeps up to date via one
 * `Cordierite.addListener` subscription for the whole process.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    PlaygroundScreen()
                }
            }
        }
    }
}

@Composable
private fun PlaygroundScreen() {
    val scope = rememberCoroutineScope()

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Cordierite native playground", style = MaterialTheme.typography.headlineSmall)
        Spacer(Modifier.height(4.dp))
        Text(
            "Scheme: cordierite-native  |  Registered tools: sum, call_count, reset_counter, " +
                "slow_task, throwing_tool",
            style = MaterialTheme.typography.bodySmall,
        )

        Spacer(Modifier.height(16.dp))
        Text("State: ${PlaygroundState.clientState}", style = MaterialTheme.typography.titleMedium)
        Text("Session: ${PlaygroundState.sessionId ?: "none"}", style = MaterialTheme.typography.titleMedium)
        Text("Call count: ${PlaygroundState.callCount}", style = MaterialTheme.typography.titleMedium)

        Spacer(Modifier.height(16.dp))
        Button(onClick = {
            scope.launch {
                Cordierite.postEvent("button_tapped", mapOf("at" to System.currentTimeMillis()))
                PlaygroundState.logEvent("posted button_tapped event")
            }
        }) {
            Text("Post event")
        }

        Spacer(Modifier.height(16.dp))
        Text("Recent events", style = MaterialTheme.typography.titleMedium)
        HorizontalDivider(modifier = Modifier.fillMaxWidth())
        LazyColumn {
            items(PlaygroundState.recentEvents) { line ->
                Text(line, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
