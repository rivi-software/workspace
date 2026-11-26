import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// What `GET /api/health` answers: how the sign-in screen tells a workspace from any other site
/// before it asks for a password, and the name the workspace goes by.
public struct WorkspaceInfo: Codable, Hashable, Sendable {
  public var ok: Bool
  public var app: String
  public var mailDomain: String
}

/// The second step of a sign-in for an account with an authenticator app: the code it shows, or
/// one of the backup codes.
public enum SecondFactor: String, Sendable, Hashable {
  case authenticator = "verify-totp"
  case backupCode = "verify-backup-code"
}

/// A sign-in waiting for its second step. The workspace keeps the first step in a short-lived
/// cookie, which this carries to the second; nothing keeps it on the phone.
public struct SecondFactorChallenge: Sendable, Hashable {
  public let server: URL
  public let email: String
  let cookie: String
}

public enum SignInResult: Sendable, Hashable {
  case signedIn(Credentials)
  case secondFactor(SecondFactorChallenge)
}

/// What went wrong signing in, in words for the person.
public enum SignInError: Error, Sendable, Equatable, LocalizedError {
  /// Something answers at the address, but not as a workspace.
  case notAWorkspace(host: String)
  case wrongPassword
  case wrongCode
  /// The workspace refused with its own words (a deactivated account).
  case refused(String)
  case throttled(retryAfterSeconds: Int?)
  /// The workspace takes no sign-in on a password alone: it confirms each one with Duo, whose
  /// prompt only a browser shows (docs/SSO.md), and answers `404` to the password endpoint.
  case passwordClosed
  case badResponse(status: Int)

  public var errorDescription: String? {
    switch self {
    case .notAWorkspace(let host):
      "\(host) doesn’t answer as a workspace. Check the address."
    case .wrongPassword:
      "That address and password don't match. Check both and try again."
    case .wrongCode:
      "That code didn't confirm the sign-in. Check it and try again."
    case .refused(let message):
      message
    case .throttled(let seconds):
      if let seconds, seconds > 0 {
        "Too many attempts. Try again in \(max(1, seconds / 60)) minutes."
      } else {
        "Too many attempts. Wait a few minutes and try again."
      }
    case .passwordClosed:
      "This workspace confirms each sign-in with Duo, which the app can't show yet. Use the workspace in a browser for now."
    case .badResponse(let status):
      "The workspace answered with status \(status)."
    }
  }
}

/// Signing in to a workspace as its API reference says (docs/API.md, Signing in): Better Auth's
/// own endpoints under `/api/auth`, the person's address and password, then the authenticator's
/// code where the account has one; the session token comes back in `set-auth-token` and goes on
/// every API request as a bearer token.
public struct Authenticator: Sendable {
  public let server: URL
  let session: URLSession

  /// `session` should keep no cookies of its own (`cookieless()`): the second step's cookie is
  /// carried by hand, so nothing of a sign-in lingers in the shared cookie store.
  public init(server: URL, session: URLSession = Authenticator.cookieless()) {
    self.server = server
    self.session = session
  }

  public static func cookieless() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpCookieStorage = nil
    return URLSession(configuration: configuration)
  }

  /// Whether a workspace answers at the server: `/api/health` with `ok: true`. Throws the
  /// transport's error when nothing answers, `notAWorkspace` when something else does.
  public func checkWorkspace() async throws -> WorkspaceInfo {
    var request = URLRequest(url: server.appending(path: "api/health"))
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let (data, response) = try await session.data(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200..<300).contains(status),
      let info = try? JSONDecoder().decode(WorkspaceInfo.self, from: data), info.ok
    else { throw SignInError.notAWorkspace(host: server.host() ?? server.absoluteString) }
    return info
  }

  /// `POST /api/auth/sign-in/email`: signed in, or the second step to take.
  public func signIn(email: String, password: String) async throws -> SignInResult {
    let email = email.trimmingCharacters(in: .whitespacesAndNewlines)
    let (data, response) = try await post(
      "api/auth/sign-in/email", ["email": email, "password": password])
    // While Duo is set up, Better Auth's password endpoint is closed (`404`).
    if response.statusCode == 404 { throw SignInError.passwordClosed }
    try check(data, response, wrong: .wrongPassword)
    // The second step first: its answer holds no session, whatever else it carries.
    let answer = try? JSONDecoder().decode(SignInAnswer.self, from: data)
    if answer?.twoFactorRedirect == true {
      guard let cookie = twoFactorCookie(response) else {
        throw SignInError.badResponse(status: response.statusCode)
      }
      return .secondFactor(SecondFactorChallenge(server: server, email: email, cookie: cookie))
    }
    guard let token = token(data, response) else {
      throw SignInError.badResponse(status: response.statusCode)
    }
    return .signedIn(Credentials(token: token, server: server, email: email))
  }

  /// The second step: the authenticator's six digits, or a backup code.
  public func verify(
    _ challenge: SecondFactorChallenge, code: String, with factor: SecondFactor
  ) async throws -> Credentials {
    let code = code.filter { !$0.isWhitespace }
    // Better Auth takes a request that carries cookies only from an origin it trusts: the
    // workspace's own (`APP_URL`), which is the server's origin.
    let (data, response) = try await post(
      "api/auth/two-factor/\(factor.rawValue)", ["code": code],
      headers: ["Cookie": challenge.cookie, "Origin": origin])
    try check(data, response, wrong: .wrongCode)
    guard let token = token(data, response) else {
      throw SignInError.badResponse(status: response.statusCode)
    }
    return Credentials(token: token, server: server, email: challenge.email)
  }

  /// `POST /api/auth/sign-out`: ends the session in the workspace. A failure still signs the app
  /// out; the session then ends on its own, or under Settings → Account.
  public func signOut(_ credentials: Credentials) async {
    _ = try? await post(
      "api/auth/sign-out", [:], headers: ["Authorization": "Bearer \(credentials.token)"])
  }

  // MARK: The wire

  var origin: String {
    var parts = URLComponents()
    parts.scheme = server.scheme
    parts.host = server.host()
    parts.port = server.port
    return parts.string ?? server.absoluteString
  }

  private func post(
    _ path: String, _ body: [String: String], headers: [String: String] = [:]
  ) async throws -> (Data, HTTPURLResponse) {
    var request = URLRequest(url: server.appending(path: path))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw SignInError.badResponse(status: 0) }
    return (data, http)
  }

  /// Throws for an answer that is no success: `wrong` for a refused password or code, the
  /// workspace's words for a refusal it explains (`403`, a deactivated account), the wait for
  /// `429`.
  private func check(_ data: Data, _ response: HTTPURLResponse, wrong: SignInError) throws {
    let status = response.statusCode
    if (200..<300).contains(status) { return }
    let problem = try? JSONDecoder().decode(AuthProblem.self, from: data)
    switch status {
    case 400, 401: throw wrong
    case 403: throw SignInError.refused(problem?.message ?? "The workspace refused the sign-in.")
    case 429:
      throw SignInError.throttled(
        retryAfterSeconds: response.value(forHTTPHeaderField: "Retry-After").flatMap { Int($0) })
    default: throw SignInError.badResponse(status: status)
    }
  }

  /// The session token: the `set-auth-token` header (Better Auth's `bearer` plugin), else the
  /// body's `token`.
  private func token(_ data: Data, _ response: HTTPURLResponse) -> String? {
    if let header = response.value(forHTTPHeaderField: "set-auth-token"), !header.isEmpty {
      return header
    }
    let answer = try? JSONDecoder().decode(SignInAnswer.self, from: data)
    return answer?.token.flatMap { $0.isEmpty ? nil : $0 }
  }

  /// `name=value` of the two-factor cookie the first step set: `workspace.two_factor`, with
  /// `__Secure-` before it where the workspace runs on HTTPS.
  func twoFactorCookie(_ response: HTTPURLResponse) -> String? {
    var fields: [String: String] = [:]
    for (key, value) in response.allHeaderFields {
      if let key = key as? String, let value = value as? String { fields[key] = value }
    }
    let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: server)
    return cookies.first { $0.name.hasSuffix("workspace.two_factor") }
      .map { "\($0.name)=\($0.value)" }
  }
}

struct SignInAnswer: Decodable {
  var token: String?
  var twoFactorRedirect: Bool?
}

struct AuthProblem: Decodable {
  var code: String?
  var message: String?
}
