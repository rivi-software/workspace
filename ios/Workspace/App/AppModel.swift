import Foundation
import Observation
import WorkspaceKit

/// The app's state: who is signed in, to which workspace, and the client that talks to it. The
/// workspace is the one the person named on the sign-in screen, so the client is made for it at
/// sign-in, and again for another workspace after the next.
@Observable @MainActor
final class AppModel {
  enum State: Equatable {
    case loading
    case signedOut
    case signedIn(Me)
  }

  private(set) var state: State = .loading
  private(set) var client: WorkspaceClient
  /// The reminders, and where a tapped notification opens the app.
  let notifications: NotificationsModel
  /// What the last `/me` said went wrong, shown while loading or kept beside the tabs.
  private(set) var loadError: String?
  /// The shared group inbox Mail shows, as the last `/me` described it; nil for the person's own
  /// mailbox. A new message from the create menu comes from it too, as in the console.
  private(set) var mailbox: SharedMailbox?

  private let tokenStore: any TokenStore

  init(tokenStore: any TokenStore = KeychainTokenStore()) {
    self.tokenStore = tokenStore
    let kept = try? tokenStore.load()
    client = WorkspaceClient(
      server: kept?.server ?? Server.remembered ?? Server.none, tokenStore: tokenStore)
    notifications = NotificationsModel()
    notifications.attach(client)
    watch(client)
  }

  var me: Me? {
    if case .signedIn(let me) = state { return me }
    return nil
  }

  /// The workspace signed in to.
  var server: URL { client.server }

  var host: String { server.host() ?? server.absoluteString }

  /// Whether the workspace's Assistant is on (`AI_FEATURES`); off, the app shows none of it.
  var assistantEnabled: Bool { me?.assistant.enabled ?? false }

  var inboxUnread: Int { me?.counts.inboxUnread ?? 0 }

  /// The `box` every Mail call takes: the shared inbox on show, or nil for the person's own.
  var box: String? { mailbox?.id }

  /// The counts and labels of the mailbox Mail shows.
  var mailCounts: FolderCounts? { mailbox?.counts ?? me?.counts }
  var mailLabels: [LabelRef] { mailbox?.labels ?? me?.labels ?? [] }

  /// Mail shows another mailbox: the person's own (nil) or one of their shared inboxes.
  func showMailbox(_ id: String?) {
    mailbox = id.flatMap { id in me?.mailboxes.first { $0.id == id } }
  }

  /// On launch: a kept session means signed in, pending the first `/me`.
  func start() async {
    guard await client.isSignedIn else {
      state = .signedOut
      return
    }
    await reloadMe()
    if me != nil { await notifications.signedIn() }
  }

  /// Reads `/me` again: the counts, the labels, the colleagues. A failure keeps what is shown;
  /// without anything shown yet it stays on the loading screen with the words.
  func reloadMe() async {
    loadError = nil
    do {
      let me = try await client.me()
      state = .signedIn(me)
      // The shared inbox on show, with its new counts; gone when the person left the group.
      mailbox = mailbox.flatMap { shown in me.mailboxes.first { $0.id == shown.id } }
    } catch APIError.unauthenticated {
      state = .signedOut
      notifications.signedOut()
    } catch {
      loadError = error.localizedDescription
      if me == nil { state = .loading }
    }
  }

  /// The sign-in screen's steps are done: keep the session, with a client for its workspace.
  func signedIn(_ credentials: Credentials) async throws {
    mailbox = nil
    if credentials.server != client.server {
      client = WorkspaceClient(server: credentials.server, tokenStore: tokenStore)
      notifications.attach(client)
      watch(client)
    }
    try await client.setCredentials(credentials)
    Server.remembered = credentials.server
    await reloadMe()
    if me != nil { await notifications.signedIn() }
  }

  /// Ends the session in the workspace and forgets it here; a sign-out the workspace does not
  /// hear still signs out here, and the session then ends on its own.
  func signOut() async {
    if let credentials = await client.currentCredentials {
      await Authenticator(server: credentials.server).signOut(credentials)
    }
    try? await client.setCredentials(nil)
    notifications.signedOut()
    mailbox = nil
    loadError = nil
    state = .signedOut
  }

  /// The workspace ended the session (signed out in the console, a new password): the sign-in
  /// screen. Only for the client in use; one replaced since says nothing.
  private func watch(_ watched: WorkspaceClient) {
    let signedOut: @Sendable () -> Void = { [weak self] in
      Task { @MainActor in
        guard let self, self.client === watched else { return }
        self.state = .signedOut
        self.notifications.signedOut()
      }
    }
    Task { await watched.onAuthenticationLost(signedOut) }
  }
}
