import Foundation
import Testing

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@testable import WorkspaceKit

struct WorkspaceAddressTests {
  private func parsed(_ input: String, local: Bool = false) -> String? {
    (try? WorkspaceAddress.parse(input, allowsLocalHTTP: local))?.absoluteString
  }

  @Test func takesWhatAPersonTypesAsTheWorkspacesOriginOverHTTPS() {
    #expect(parsed("workspace.example.com") == "https://workspace.example.com")
    #expect(parsed("  workspace.example.com  ") == "https://workspace.example.com")
    #expect(parsed("https://workspace.example.com/mail?folder=inbox#top") == "https://workspace.example.com")
    #expect(parsed("HTTPS://Workspace.Example.COM/") == "https://workspace.example.com")
    #expect(parsed("workspace.example.com:8443/drive") == "https://workspace.example.com:8443")
    #expect(parsed("mail.team.workers.dev") == "https://mail.team.workers.dev")
  }

  @Test func refusesWhatIsNoHTTPSWorkspace() {
    #expect(throws: AddressError.empty) { try WorkspaceAddress.parse("  ", allowsLocalHTTP: false) }
    #expect(throws: AddressError.insecure) {
      try WorkspaceAddress.parse("http://workspace.example.com", allowsLocalHTTP: false)
    }
    #expect(throws: AddressError.credentials) {
      try WorkspaceAddress.parse("https://ada:secret@workspace.example.com", allowsLocalHTTP: false)
    }
    for input in ["workspace", "localhost:5174", "http://localhost:5174", "ftp://workspace.example.com"] {
      #expect(parsed(input) == nil, "\(input)")
    }
  }

  @Test func takesALocalWorkspaceOverHTTPOnlyInADebugBuild() {
    #expect(parsed("http://localhost:5174/mail", local: true) == "http://localhost:5174")
    #expect(parsed("http://192.168.1.20:5174", local: true) == "http://192.168.1.20:5174")
    #expect(parsed("http://10.0.2.2:5174", local: true) == "http://10.0.2.2:5174")
    #expect(parsed("http://workspace.example.com", local: true) == nil)
    #expect(parsed("http://8.8.8.8", local: true) == nil)
  }

  @Test func showsAKeptAddressAsItWasTyped() throws {
    #expect(WorkspaceAddress.editable(try #require(URL(string: "https://workspace.example.com"))) == "workspace.example.com")
    #expect(WorkspaceAddress.editable(try #require(URL(string: "https://a.example.com:8443"))) == "a.example.com:8443")
    #expect(WorkspaceAddress.editable(try #require(URL(string: "http://localhost:5174"))) == "http://localhost:5174")
  }
}

struct AuthenticatorTests {
  private func authenticator(_ host: String) throws -> Authenticator {
    Authenticator(
      server: try #require(URL(string: "https://\(host)")),
      session: StubURLProtocol.session(cookies: false))
  }

  private func json(_ call: StubURLProtocol.Call) -> [String: String] {
    (try? JSONDecoder().decode([String: String].self, from: call.body)) ?? [:]
  }

  @Test func knowsAWorkspaceByItsHealthAnswer() async throws {
    let host = StubServer.host()
    let other = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      call.path == "/api/health"
        ? .init(json: #"{"ok":true,"app":"Acme Workspace","mailDomain":"acme.com","time":"2026-11-26T00:00:00Z"}"#)
        : .init(status: 404, json: "{}")
    }
    StubURLProtocol.register(host: other) { _ in
      .init(status: 200, body: Data("<html>".utf8), contentType: "text/html")
    }
    let info = try await authenticator(host).checkWorkspace()
    #expect(info.app == "Acme Workspace")
    #expect(info.mailDomain == "acme.com")
    await #expect(throws: SignInError.notAWorkspace(host: other)) {
      _ = try await authenticator(other).checkWorkspace()
    }
  }

  @Test func signsInWithThePasswordAndKeepsTheSessionToken() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      .init(
        json: #"{"token":"ses_body","user":{"id":"usr_1","email":"ada@acme.com"}}"#,
        headers: ["set-auth-token": "ses_header"])
    }
    let result = try await authenticator(host).signIn(email: " ada@acme.com ", password: "correct horse")
    let call = try #require(StubURLProtocol.calls(host: host).first)
    #expect(call.path == "/api/auth/sign-in/email")
    #expect(call.request.httpMethod == "POST")
    #expect(json(call) == ["email": "ada@acme.com", "password": "correct horse"])
    guard case .signedIn(let credentials) = result else {
      Issue.record("Expected a sign-in, got \(result)")
      return
    }
    #expect(credentials.token == "ses_header")
    #expect(credentials.server.host() == host)
    #expect(credentials.email == "ada@acme.com")
  }

  @Test func takesTheSecondStepWithTheCookieAndTheWorkspacesOrigin() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      switch call.path {
      case "/api/auth/sign-in/email":
        return .init(
          json: #"{"twoFactorRedirect":true}"#,
          headers: [
            "Set-Cookie":
              "__Secure-workspace.two_factor=abc.sig%3D; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600"
          ])
      case "/api/auth/two-factor/verify-totp":
        let cookie = call.request.value(forHTTPHeaderField: "Cookie")
        let origin = call.request.value(forHTTPHeaderField: "Origin")
        guard cookie == "__Secure-workspace.two_factor=abc.sig%3D", origin == "https://\(host)" else {
          return .init(status: 403, json: #"{"message":"Missing or invalid origin"}"#)
        }
        guard self.json(call)["code"] == "123456" else {
          return .init(status: 401, json: #"{"code":"INVALID_CODE","message":"Invalid code"}"#)
        }
        return .init(json: #"{"token":"ses_2fa"}"#, headers: ["set-auth-token": "ses_2fa"])
      default:
        return .init(status: 404, json: "{}")
      }
    }
    let auth = try authenticator(host)
    let result = try await auth.signIn(email: "ada@acme.com", password: "correct horse")
    guard case .secondFactor(let challenge) = result else {
      Issue.record("Expected a second step, got \(result)")
      return
    }
    await #expect(throws: SignInError.wrongCode) {
      _ = try await auth.verify(challenge, code: "000000", with: .authenticator)
    }
    let credentials = try await auth.verify(challenge, code: "123 456", with: .authenticator)
    #expect(credentials.token == "ses_2fa")
    #expect(credentials.email == "ada@acme.com")
  }

  @Test func saysWhyASignInWasRefused() async throws {
    let host = StubServer.host()
    let status = Counter()
    StubURLProtocol.register(host: host) { _ in
      switch status.next() {
      case 1: return .init(status: 401, json: #"{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}"#)
      case 2:
        return .init(
          status: 403,
          json: #"{"code":"ACCOUNT_DEACTIVATED","message":"This account has been deactivated. Ask an admin to reactivate it."}"#)
      case 3: return .init(status: 429, json: "{}", headers: ["Retry-After": "600"])
      default: return .init(status: 404, json: #"{"message":"Not found"}"#)
      }
    }
    let auth = try authenticator(host)
    await #expect(throws: SignInError.wrongPassword) { _ = try await auth.signIn(email: "a@acme.com", password: "x") }
    await #expect(throws: SignInError.refused("This account has been deactivated. Ask an admin to reactivate it.")) {
      _ = try await auth.signIn(email: "a@acme.com", password: "x")
    }
    await #expect(throws: SignInError.throttled(retryAfterSeconds: 600)) {
      _ = try await auth.signIn(email: "a@acme.com", password: "x")
    }
    // Duo on: the password endpoint is closed, and the app says why rather than a status.
    await #expect(throws: SignInError.passwordClosed) {
      _ = try await auth.signIn(email: "a@acme.com", password: "x")
    }
    #expect(SignInError.throttled(retryAfterSeconds: 600).errorDescription == "Too many attempts. Try again in 10 minutes.")
  }

  @Test func signsOutWithTheBearerToken() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { _ in .init(json: #"{"success":true}"#) }
    let auth = try authenticator(host)
    await auth.signOut(Credentials(token: "ses_1", server: auth.server, email: "ada@acme.com"))
    let call = try #require(StubURLProtocol.calls(host: host).first)
    #expect(call.path == "/api/auth/sign-out")
    #expect(call.bearer == "ses_1")
  }

  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func next() -> Int { lock.withLock { count += 1; return count } }
  }
}
