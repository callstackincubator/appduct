import AppductCore
import SwiftUI

/// Two screens, Tools and Status, switched by a tab bar of plain buttons: a `TabView` item cannot
/// carry an accessibility identifier on iOS 15, which is this target's deployment target (matching
/// `Package.swift`'s `.iOS("15.1")` platform floor for `AppductCore` itself). Each value a test
/// runner reads carries the identifier from `docs/internal/playground-contract.md`, and its label is
/// a separate `Text`.
struct ContentView: View {
  @ObservedObject private var viewModel = PlaygroundViewModel.shared

  var body: some View {
    VStack(spacing: 0) {
      switch viewModel.screen {
      case .tools:
        ToolsScreen(viewModel: viewModel)
      case .status:
        StatusScreen(viewModel: viewModel)
      }
      Divider()
      HStack {
        tab("Tools", id: "tab-tools", screen: .tools)
        tab("Status", id: "tab-status", screen: .status)
      }
      .padding(.vertical, 8)
    }
  }

  private func tab(_ title: String, id: String, screen: PlaygroundViewModel.Screen) -> some View {
    Button(title) { viewModel.screen = screen }
      .frame(maxWidth: .infinity)
      .foregroundColor(viewModel.screen == screen ? .accentColor : .secondary)
      .accessibilityIdentifier(id)
  }
}

/// `NavigationView`/plain `HStack` rows rather than `NavigationStack`/`LabeledContent`: both of
/// those SwiftUI APIs need iOS 16.
private func row(_ label: String, _ value: String, id: String? = nil) -> some View {
  HStack {
    Text(label)
    Spacer()
    if let id {
      Text(value)
        .foregroundColor(.secondary)
        .accessibilityIdentifier(id)
    } else {
      Text(value)
        .foregroundColor(.secondary)
    }
  }
}

private struct ToolsScreen: View {
  @ObservedObject var viewModel: PlaygroundViewModel

  var body: some View {
    NavigationView {
      List {
        Section(header: Text("Call counter")) {
          row("Count", "\(viewModel.callCount)", id: "call-count")
          Text("Bumped by sum/slow_task; call_count reads it back; reset_counter zeroes it.")
            .font(.caption)
            .foregroundColor(.secondary)
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Appduct")
    }
  }
}

private struct StatusScreen: View {
  @ObservedObject var viewModel: PlaygroundViewModel
  @State private var isPostingEvent = false
  @State private var postEventResult: String?

  var body: some View {
    NavigationView {
      List {
        Section(header: Text("Connection")) {
          row("State", viewModel.state.rawValue, id: "connection-state")
          row("Alias", viewModel.alias ?? "none", id: "session-alias")
          row("Last session event", viewModel.lastSessionEvent ?? "none", id: "last-session-event")
          row("Session", viewModel.sessionId ?? "none")
          row("Trust", Appduct.shared.buildConfig.trust)
        }

        Section(header: Text("Post an app event")) {
          Button(isPostingEvent ? "Posting…" : "Send playground_ping") {
            postEvent()
          }
          .disabled(isPostingEvent)
          .accessibilityIdentifier("ping-button")
          row("Last ping", viewModel.lastPing.map { "\($0)" } ?? "none", id: "last-ping")
          if let postEventResult {
            Text(postEventResult)
              .font(.caption)
              .foregroundColor(.secondary)
          }
        }

        Section(header: Text("Recent activity")) {
          if viewModel.log.isEmpty {
            Text("Nothing yet -- open an appduct link to connect.")
              .font(.caption)
              .foregroundColor(.secondary)
          } else {
            ForEach(Array(viewModel.log.enumerated()), id: \.offset) { _, line in
              Text(line)
                .font(.system(.caption, design: .monospaced))
            }
          }
        }
      }
      .listStyle(.insetGrouped)
      .navigationTitle("Status")
    }
  }

  private func postEvent() {
    isPostingEvent = true
    Task { @MainActor in
      defer { isPostingEvent = false }
      let at = Int(Date().timeIntervalSince1970 * 1000)
      do {
        try await Appduct.shared.postEvent("playground_ping", payload: ["at": at])
        viewModel.recordPing(at: at)
        postEventResult = "Posted at \(Date().formatted(date: .omitted, time: .standard))."
        viewModel.appendLog("posted playground_ping")
      } catch {
        postEventResult = "Failed: \(error)"
        viewModel.appendLog("postEvent failed: \(error)")
      }
    }
  }
}

#Preview {
  ContentView()
}
