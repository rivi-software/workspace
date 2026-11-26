import SwiftUI

/// Loading, the sign-in screen, or the tabs, by the app's state.
struct RootView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    Group {
      switch app.state {
      case .loading:
        LoadingView()
      case .signedOut:
        SignInView()
      case .signedIn:
        MainTabView()
      }
    }
    .animation(.default, value: screen)
  }

  private var screen: Int {
    switch app.state {
    case .loading: 0
    case .signedOut: 1
    case .signedIn: 2
    }
  }
}

/// The first `/me` on its way, with its error and a way out when it fails.
struct LoadingView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    VStack(spacing: 16) {
      if let error = app.loadError {
        ErrorBanner(message: error) { await app.reloadMe() }
        Button("Sign out") { Task { await app.signOut() } }
          .font(.subheadline)
      } else {
        WorkspaceLoader(size: 30)
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.canvas.ignoresSafeArea())
  }
}
