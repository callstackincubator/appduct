package com.callstack.appduct.playground

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
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import com.callstack.appduct.Appduct
import kotlinx.coroutines.launch

/**
 * The playground's two screens, Tools and Status, switched by a tab bar, as the playground
 * contract (`docs/internal/playground-contract.md`) lays out. Each value a test runner reads
 * carries the contract's test tag, and its label is a separate [Text]. `testTagsAsResourceId` on
 * the root is what makes the tags visible to UI Automator as resource ids.
 * Deep links never reach here directly: `AppductLinkActivity` (declared in `core`'s manifest)
 * is the exported entry point for `appduct-native://` links, and this activity's UI just
 * reflects [PlaygroundState], which [PlaygroundApplication] keeps up to date via one
 * `Appduct.addListener` subscription for the whole process.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                PlaygroundScreen()
            }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun PlaygroundScreen() {
    Scaffold(
        modifier = Modifier.fillMaxSize().semantics { testTagsAsResourceId = true },
        bottomBar = {
            NavigationBar {
                for ((screen, title, tag) in listOf(
                    Triple(PlaygroundState.Screen.Tools, "Tools", "tab-tools"),
                    Triple(PlaygroundState.Screen.Status, "Status", "tab-status"),
                )) {
                    NavigationBarItem(
                        selected = PlaygroundState.screen == screen,
                        onClick = { PlaygroundState.screen = screen },
                        icon = {},
                        label = { Text(title) },
                        modifier = Modifier.testTag(tag),
                    )
                }
            }
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding).padding(16.dp)) {
            when (PlaygroundState.screen) {
                PlaygroundState.Screen.Tools -> ToolsScreen()
                PlaygroundState.Screen.Status -> StatusScreen()
            }
        }
    }
}

/** A labelled value; the tagged [Text] holds only [value]. */
@Composable
private fun Value(label: String, value: String, tag: String) {
    Text(label, style = MaterialTheme.typography.bodySmall)
    Text(value, style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag(tag))
}

@Composable
private fun ToolsScreen() {
    Text("Appduct native playground", style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(4.dp))
    Text(
        "Scheme: appduct-native  |  Registered tools: sum, call_count, reset_counter, " +
            "slow_task, throwing_tool",
        style = MaterialTheme.typography.bodySmall,
    )

    Spacer(Modifier.height(16.dp))
    Value("Call counter", "${PlaygroundState.callCount}", "call-count")
}

@Composable
private fun StatusScreen() {
    val scope = rememberCoroutineScope()

    Value("Connection", PlaygroundState.clientState.name, "connection-state")
    Spacer(Modifier.height(8.dp))
    Value("Alias", PlaygroundState.alias ?: "none", "session-alias")
    Spacer(Modifier.height(8.dp))
    Value("Last session event", PlaygroundState.lastSessionEvent ?: "none", "last-session-event")
    Spacer(Modifier.height(8.dp))
    Text("Session: ${PlaygroundState.sessionId ?: "none"}", style = MaterialTheme.typography.bodySmall)

    Spacer(Modifier.height(16.dp))
    Button(
        onClick = {
            scope.launch {
                val at = System.currentTimeMillis()
                Appduct.postEvent("playground_ping", mapOf("at" to at))
                PlaygroundState.lastPing = at
                PlaygroundState.logEvent("posted playground_ping event")
            }
        },
        modifier = Modifier.testTag("ping-button"),
    ) {
        Text("Send playground_ping")
    }
    Spacer(Modifier.height(8.dp))
    Value("Last ping", PlaygroundState.lastPing?.toString() ?: "none", "last-ping")

    Spacer(Modifier.height(16.dp))
    Text("Recent events", style = MaterialTheme.typography.titleMedium)
    HorizontalDivider(modifier = Modifier.fillMaxWidth())
    LazyColumn {
        items(PlaygroundState.recentEvents) { line ->
            Text(line, style = MaterialTheme.typography.bodySmall)
        }
    }
}
