import CordieriteCore
import SwiftUI

/// `NavigationView`/plain `HStack` rows rather than `NavigationStack`/`LabeledContent`: this target's
/// deployment target is iOS 15.1, matching `Package.swift`'s `.iOS("15.1")` platform floor for
/// `CordieriteCore` itself, and both of those SwiftUI APIs need iOS 16.
struct ContentView: View {
  @ObservedObject private var viewModel = PlaygroundViewModel.shared
  @State private var isPostingEvent = false
  @State private var postEventResult: String?

  var body: some View {
    NavigationView {
      List {
        Section(header: Text("Connection")) {
          row("State", viewModel.state.rawValue)
          row("Session", viewModel.sessionId ?? "none")
          row("Trust", Cordierite.shared.buildConfig.trust)
        }

        Section(header: Text("Call counter")) {
          row("Count", "\(viewModel.callCount)")
          Text("Bumped by sum/slow_task; call_count reads it back; reset_counter zeroes it.")
            .font(.caption)
            .foregroundColor(.secondary)
        }

        Section(header: Text("Post an app event")) {
          Button(isPostingEvent ? "Posting…" : "Post playground_button_tap") {
            postEvent()
          }
          .disabled(isPostingEvent)
          if let postEventResult {
            Text(postEventResult)
              .font(.caption)
              .foregroundColor(.secondary)
          }
        }

        Section(header: Text("Recent activity")) {
          if viewModel.log.isEmpty {
            Text("Nothing yet -- open a cordierite link to connect.")
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
      .navigationTitle("Cordierite")
      .task {
        // Started here, not from `CordieritePlaygroundApp.init()`: `PlaygroundViewModel` is
        // `@MainActor`, and `.task`'s closure runs on the view's actor (MainActor for a plain
        // SwiftUI app), so this is the first point guaranteed safe to touch it without an explicit
        // hop. Idempotent against SwiftUI re-invoking `.task` (e.g. after a view identity change).
        viewModel.start()
      }
    }
  }

  private func row(_ label: String, _ value: String) -> some View {
    HStack {
      Text(label)
      Spacer()
      Text(value)
        .foregroundColor(.secondary)
    }
  }

  private func postEvent() {
    isPostingEvent = true
    Task { @MainActor in
      defer { isPostingEvent = false }
      do {
        try await Cordierite.shared.postEvent(
          "playground_button_tap",
          payload: ["callCount": viewModel.callCount]
        )
        postEventResult = "Posted at \(Date().formatted(date: .omitted, time: .standard))."
        viewModel.appendLog("posted playground_button_tap")
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
