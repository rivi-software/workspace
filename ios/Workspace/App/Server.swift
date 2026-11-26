import Foundation
import WorkspaceKit

/// Which workspace the app signs in to. Every deployment of Workspace has its own address, so the
/// person names theirs on the sign-in screen; the app remembers the last one it signed in to and
/// offers it again. A debug build launched with `WORKSPACE_URL` (`http://localhost:5174`, from
/// Xcode's scheme, `SIMCTL_CHILD_WORKSPACE_URL` or the launch argument `-WORKSPACE_URL`) offers
/// that address instead, for a local workspace (`pnpm run dev`); a release build reads none of
/// them.
enum Server {
  /// Whether the sign-in screen takes plain HTTP to this machine or a private network: in a debug
  /// build alone, for a workspace on the developer's computer.
  static var allowsLocalHTTP: Bool {
    #if DEBUG
      true
    #else
      false
    #endif
  }

  /// The address the sign-in screen starts with, as the person would type it.
  static func suggestion(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    arguments: [String: Any] = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
  ) -> String {
    #if DEBUG
      if let raw = environment[launchKey] ?? arguments[launchKey] as? String, !raw.isEmpty {
        return raw
      }
    #endif
    return remembered.map(WorkspaceAddress.editable) ?? ""
  }

  /// The workspace the app last signed in to, kept on the phone (no secret: the session is in
  /// the Keychain).
  static var remembered: URL? {
    get { UserDefaults.standard.url(forKey: rememberedKey) }
    set { UserDefaults.standard.set(newValue, forKey: rememberedKey) }
  }

  /// The client's address before anyone signed in: no workspace, and nothing is sent there.
  static let none: URL = {
    guard let url = URL(string: "https://workspace.invalid") else {
      preconditionFailure("Not a URL: https://workspace.invalid")
    }
    return url
  }()

  private static let launchKey = "WORKSPACE_URL"
  private static let rememberedKey = "workspace.server"
}
