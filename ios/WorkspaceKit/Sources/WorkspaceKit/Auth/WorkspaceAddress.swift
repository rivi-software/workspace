import Foundation

/// Why an address a person typed is no workspace's address, in words for them.
public enum AddressError: Error, Sendable, Equatable, LocalizedError {
  case empty
  case notAnAddress(String)
  case credentials
  case insecure

  public var errorDescription: String? {
    switch self {
    case .empty: "Enter your workspace's address."
    case .notAnAddress(let input): "“\(input)” is not a web address."
    case .credentials: "Leave the user name and password out of the address."
    case .insecure: "The workspace must be served over HTTPS. Start the address with https://."
    }
  }
}

/// The address of a workspace as a person types it on the sign-in screen: every deployment of
/// Workspace has its own. The same rules as the Android and Tauri app's (mobile/src-tauri/src/
/// workspace.rs): `https://` when no scheme is named, the origin alone kept, so a link pasted from
/// a page of the workspace works; HTTPS only, except plain HTTP to this machine or a private network
/// in a debug build, for a workspace on the developer's computer.
public enum WorkspaceAddress {
  public static func parse(_ input: String, allowsLocalHTTP: Bool) throws -> URL {
    let input = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !input.isEmpty else { throw AddressError.empty }
    let address = input.contains("://") ? input : "https://\(input)"
    guard let parts = URLComponents(string: address), let scheme = parts.scheme?.lowercased(),
      let host = parts.host?.lowercased(), !host.isEmpty
    else { throw AddressError.notAnAddress(input) }
    guard parts.user == nil, parts.password == nil else { throw AddressError.credentials }

    let local = isLocal(host)
    switch scheme {
    case "https":
      // A name on the internet; a word alone (`workspace`) is none.
      guard host.contains(".") || (allowsLocalHTTP && local) else {
        throw AddressError.notAnAddress(input)
      }
    case "http":
      guard host.contains(".") || local else { throw AddressError.notAnAddress(input) }
      guard allowsLocalHTTP, local else { throw AddressError.insecure }
    default:
      throw AddressError.notAnAddress(input)
    }

    var origin = URLComponents()
    origin.scheme = scheme
    origin.host = host
    origin.port = parts.port
    guard let url = origin.url else { throw AddressError.notAnAddress(input) }
    return url
  }

  /// What the sign-in screen shows for a kept address: the host alone over HTTPS, which the app
  /// assumes, the whole origin otherwise, so the field takes it back as it was.
  public static func editable(_ server: URL) -> String {
    guard let host = server.host() else { return server.absoluteString }
    if server.scheme == "https" {
      return server.port.map { "\(host):\($0)" } ?? host
    }
    return server.absoluteString.hasSuffix("/")
      ? String(server.absoluteString.dropLast()) : server.absoluteString
  }

  /// This machine, or a private network (RFC 1918), which a simulator and a phone on the
  /// developer's Wi-Fi reach a local workspace by.
  static func isLocal(_ host: String) -> Bool {
    if host == "localhost" || host == "[::1]" || host == "::1" { return true }
    let octets = host.split(separator: ".").compactMap { UInt8($0) }
    guard octets.count == 4, host.split(separator: ".").count == 4 else { return false }
    switch (octets[0], octets[1]) {
    case (127, _), (10, _), (192, 168): return true
    case (172, 16...31): return true
    default: return false
    }
  }
}
