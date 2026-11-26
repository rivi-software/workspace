import SwiftUI

/// The buttons at the top of every tab: the Assistant at the top left, whose face is the RIVI
/// mark's bars, opening in a sheet over whichever tab is on show; the avatar, which opens
/// Settings; and the create menu at the far right (`.primaryAction`, so it stays last whatever
/// the root adds to the bar).
private struct TabToolbar: ViewModifier {
  @Environment(AppModel.self) private var app
  @State private var showingAssistant = false
  @State private var showingSettings = false
  @Namespace private var transition

  private static let assistantSource = "assistant"

  func body(content: Content) -> some View {
    content
      .toolbar {
        // Not while the workspace's AI is off (`AI_FEATURES`), as the console hides its module.
        if app.assistantEnabled {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              showingAssistant = true
            } label: {
              SignalMeter(height: 17, active: false, bars: Theme.foreground)
            }
            .accessibilityLabel("Assistant")
          }
          .matchedTransitionSource(id: Self.assistantSource, in: transition)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            showingSettings = true
          } label: {
            AvatarView(name: app.me?.user.name ?? "?", size: 28)
          }
          .accessibilityLabel("Account and settings")
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) {
          CreateMenu()
        }
      }
      .sheet(isPresented: $showingAssistant) {
        NavigationStack {
          AssistantRootView()
        }
        .navigationTransition(.zoom(sourceID: Self.assistantSource, in: transition))
      }
      .sheet(isPresented: $showingSettings) {
        SettingsView()
      }
  }
}

extension View {
  /// Adds the Assistant, account and create buttons every tab's root view carries. A root's own
  /// leading items follow the Assistant: put a `ToolbarSpacer(.fixed, placement: .topBarLeading)`
  /// before them, or they share its glass. Its own trailing items share the avatar's.
  func tabToolbar() -> some View {
    modifier(TabToolbar())
  }
}
