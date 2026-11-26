import SafariServices
import SwiftUI

/// A page of the workspace in Safari's view controller, so the person's Safari session applies.
struct AssistantSafariView: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> SFSafariViewController {
    let controller = SFSafariViewController(url: url)
    controller.dismissButtonStyle = .close
    return controller
  }

  func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}

/// A workspace page to open, as a sheet's item.
struct AssistantSafariLink: Identifiable {
  let url: URL

  var id: String { url.absoluteString }
}

enum AssistantLinks {
  /// The page on the workspace a link in an answer points at: a path of the console
  /// (`/mail/t/<id>`, `/drive/d/<id>`) resolved against the workspace, or a link on the workspace's
  /// host. Nil for any other link, which the system opens.
  static func consoleURL(_ url: URL, server: URL) -> URL? {
    if url.scheme == nil {
      return URL(string: url.relativeString, relativeTo: server)?.absoluteURL
    }
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
      let host = url.host()?.lowercased(), host == server.host()?.lowercased()
    else { return nil }
    return url
  }
}
