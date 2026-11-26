import SwiftUI

extension View {
  /// Keeps a tab's data as current as the console keeps its pages (`useRefresh`): `reload` runs
  /// when the app comes back from the background, and once a minute while the screen is on show.
  /// What changed elsewhere (mail archived in the browser, a task done on the Mac, new mail) then
  /// shows without a pull. The screen's own `.task` makes the first load; a screen under a pushed
  /// one, or in another tab, waits until it shows again.
  func reloadsWhileOpen(_ reload: @escaping @MainActor () async -> Void) -> some View {
    modifier(ReloadWhileOpen(reload: reload))
  }
}

private struct ReloadWhileOpen: ViewModifier {
  private static let interval: Duration = .seconds(60)

  let reload: @MainActor () async -> Void
  @Environment(\.scenePhase) private var scenePhase
  /// The app went to the background since this screen last loaded.
  @State private var wasAway = false

  func body(content: Content) -> some View {
    content
      .onChange(of: scenePhase) { _, phase in
        if phase == .background { wasAway = true }
      }
      .task(id: scenePhase) {
        guard scenePhase == .active else { return }
        if wasAway {
          wasAway = false
          await reload()
        }
        while !Task.isCancelled {
          try? await Task.sleep(for: Self.interval)
          guard !Task.isCancelled else { return }
          await reload()
        }
      }
  }
}
