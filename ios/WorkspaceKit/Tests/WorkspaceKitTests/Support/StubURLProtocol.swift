import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

@testable import WorkspaceKit

/// Answers requests from a handler per host, so tests reach no network. Each test registers its
/// own host (`StubServer.host()`), since Swift Testing runs tests in parallel.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
  struct Call: Sendable {
    let request: URLRequest
    let body: Data
    var path: String { request.url?.path() ?? "" }
    var bearer: String? {
      request.value(forHTTPHeaderField: "Authorization")?.replacingOccurrences(of: "Bearer ", with: "")
    }
    var form: [String: String] {
      var fields: [String: String] = [:]
      for pair in String(decoding: body, as: UTF8.self).split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { continue }
        fields[parts[0].removingPercentEncoding ?? parts[0]] = parts[1].removingPercentEncoding ?? parts[1]
      }
      return fields
    }
  }

  struct Answer: Sendable {
    var status: Int
    var body: Data
    var contentType: String
    var headers: [String: String] = [:]

    init(status: Int = 200, json: String, headers: [String: String] = [:]) {
      self.status = status
      body = Data(json.utf8)
      contentType = "application/json"
      self.headers = headers
    }

    init(status: Int = 200, body: Data, contentType: String) {
      self.status = status
      self.body = body
      self.contentType = contentType
    }
  }

  typealias Handler = @Sendable (Call) -> Answer

  private final class Registry: @unchecked Sendable {
    let lock = NSLock()
    var handlers: [String: Handler] = [:]
    var calls: [String: [Call]] = [:]
  }

  private static let registry = Registry()
  private static let registered: Bool = {
    URLProtocol.registerClass(StubURLProtocol.self)
    return true
  }()

  static func register(host: String, _ handler: @escaping Handler) {
    _ = registered
    registry.lock.withLock {
      registry.handlers[host] = handler
      registry.calls[host] = []
    }
  }

  static func calls(host: String) -> [Call] {
    registry.lock.withLock { registry.calls[host] ?? [] }
  }

  /// `cookies: false` as `Authenticator.cookieless()` makes it, so a test sees only the cookies
  /// a request carries by hand.
  static func session(cookies: Bool = true) -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    if !cookies {
      configuration.httpShouldSetCookies = false
      configuration.httpCookieAcceptPolicy = .never
      configuration.httpCookieStorage = nil
    }
    return URLSession(configuration: configuration)
  }

  override class func canInit(with request: URLRequest) -> Bool {
    guard let host = request.url?.host() else { return false }
    return registry.lock.withLock { registry.handlers[host] != nil }
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let call = Call(request: request, body: Self.body(of: request))
    guard let host = request.url?.host(),
      let handler = Self.registry.lock.withLock({ () -> Handler? in
        Self.registry.calls[host, default: []].append(call)
        return Self.registry.handlers[host]
      })
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
      return
    }
    let answer = handler(call)
    guard let url = request.url,
      let response = HTTPURLResponse(
        url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
        headerFields: answer.headers.merging(["Content-Type": answer.contentType]) { own, _ in own })
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: answer.body)
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}

  static func body(of request: URLRequest) -> Data {
    if let data = request.httpBody { return data }
    guard let stream = request.httpBodyStream else { return Data() }
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while stream.hasBytesAvailable {
      let read = stream.read(&buffer, maxLength: buffer.count)
      guard read > 0 else { break }
      data.append(buffer, count: read)
    }
    return data
  }
}

enum StubServer {
  /// A host of this test's own.
  static func host() -> String {
    "t-\(UUID().uuidString.lowercased().prefix(8)).test"
  }

  /// A signed-in client of the host, with the session token `token`.
  static func client(host: String, token: String = "ses_token") throws -> (WorkspaceClient, MemoryTokenStore) {
    guard let server = URL(string: "https://\(host)") else {
      preconditionFailure("Not a URL: https://\(host)")
    }
    let store = MemoryTokenStore(Credentials(token: token, server: server, email: "ada@example.com"))
    return (WorkspaceClient(server: server, tokenStore: store, session: StubURLProtocol.session()), store)
  }
}
