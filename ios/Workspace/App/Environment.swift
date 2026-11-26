import SwiftUI
import WorkspaceKit

/// A signed-out client for previews and for a view outside `WorkspaceApp`; one instance, since
/// an `@Entry` default is read on every access.
private enum DefaultClient {
  static let shared = WorkspaceClient(server: Server.none, tokenStore: MemoryTokenStore())
}

extension EnvironmentValues {
  /// The client every feature talks through; `WorkspaceApp` puts `AppModel`'s here, a new one
  /// after a sign-in to another workspace.
  @Entry var workspaceClient: WorkspaceClient = DefaultClient.shared
}
