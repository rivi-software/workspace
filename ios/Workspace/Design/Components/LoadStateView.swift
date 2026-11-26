import SwiftUI

/// Renders a `LoadState`: the loader, the content, or an error banner with the stale content
/// under it when there is some.
struct LoadStateView<Value, Content: View>: View {
  let state: LoadState<Value>
  var retry: (() async -> Void)?
  @ViewBuilder let content: (Value) -> Content

  var body: some View {
    switch state {
    case .idle, .loading:
      WorkspaceLoader()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    case .loaded(let value):
      content(value)
    case .failed(let message, let previous):
      VStack(spacing: 0) {
        ErrorBanner(message: message, retry: retry)
          .padding(.horizontal)
          .padding(.vertical, 8)
        if let previous {
          content(previous)
        } else {
          Spacer()
        }
      }
    }
  }
}

/// A list section that only shows the loader while the list's data is on its way, for screens
/// whose list stays up around it (Calendar's grid, Tasks' picker).
struct LoadingSection: View {
  var body: some View {
    Section {
      WorkspaceLoader(size: 22)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
    .listRowBackground(Color.clear)
  }
}
