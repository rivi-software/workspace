import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// A file the client downloaded to a temporary location; move it where it belongs.
public struct DownloadedFile: Sendable, Hashable {
  public let url: URL
  public let contentType: String?
  public let suggestedFilename: String?
}

/// The Workspace API over URLSession: the workspace's address as base URL, the session token as
/// a bearer header, JSON in and out. The session has no refresh: a `401` means it ended (signed
/// out in the console, "Sign out everywhere", a new password, a deactivation), so the sign-in goes,
/// the handler runs and the app shows the sign-in screen.
public actor WorkspaceClient {
  /// The workspace this client talks to.
  public nonisolated let server: URL
  /// `<server>/api/v1`.
  public nonisolated let apiBase: URL
  nonisolated let session: URLSession
  private let store: any TokenStore
  private var credentials: Credentials?
  private var lostHandler: (@Sendable () -> Void)?

  public init(server: URL, tokenStore: any TokenStore, session: URLSession = .shared) {
    self.server = server
    apiBase = server.appending(path: "api/v1")
    self.session = session
    store = tokenStore
    if let kept = try? tokenStore.load(), kept.server == server {
      credentials = kept
    }
  }

  /// Called once the workspace refuses the session (`401`): the app shows sign-in.
  public func onAuthenticationLost(_ handler: @escaping @Sendable () -> Void) {
    lostHandler = handler
  }

  public var isSignedIn: Bool { credentials != nil }
  public var currentCredentials: Credentials? { credentials }

  /// After a sign-in (its credentials, for this client's server) or a sign-out (nil); the store
  /// follows.
  public func setCredentials(_ credentials: Credentials?) throws {
    if let credentials {
      precondition(credentials.server == server, "A sign-in for \(credentials.server) on the client of \(server)")
      try store.save(credentials)
    } else {
      try store.clear()
    }
    self.credentials = credentials
  }

  // MARK: Typed requests

  public func get<T: Decodable & Sendable>(_ path: String, query: [(String, String?)] = []) async throws -> T {
    try await decode(send(request(.get, path, query: query)))
  }

  public func post<T: Decodable & Sendable>(
    _ path: String, query: [(String, String?)] = [], body: some Encodable & Sendable
  ) async throws -> T {
    try await decode(send(request(.post, path, query: query, json: body)))
  }

  public func post<T: Decodable & Sendable>(_ path: String, query: [(String, String?)] = []) async throws -> T {
    try await decode(send(request(.post, path, query: query)))
  }

  public func put<T: Decodable & Sendable>(
    _ path: String, query: [(String, String?)] = [], body: some Encodable & Sendable
  ) async throws -> T {
    try await decode(send(request(.put, path, query: query, json: body)))
  }

  /// A raw body (a Drive upload) with its content type.
  public func put<T: Decodable & Sendable>(
    _ path: String, query: [(String, String?)], data: Data, contentType: String
  ) async throws -> T {
    var request = request(.put, path, query: query)
    request.setValue(contentType, forHTTPHeaderField: "Content-Type")
    request.setValue(String(data.count), forHTTPHeaderField: "Content-Length")
    return try await decode(send(request, upload: data))
  }

  public func delete<T: Decodable & Sendable>(_ path: String, query: [(String, String?)] = []) async throws -> T {
    try await decode(send(request(.delete, path, query: query)))
  }

  /// Downloads a file's bytes under the API (a Drive file) to a temporary file.
  public func download(_ path: String, query: [(String, String?)] = []) async throws -> DownloadedFile {
    try await download(request(.get, path, query: query), bearer: true)
  }

  /// Downloads a signed link (a message's attachment), which needs no token.
  public func download(url: URL) async throws -> DownloadedFile {
    try await download(URLRequest(url: url), bearer: false)
  }

  /// A request a web view can load for a message's HTML document, the bearer header on it.
  public func documentRequest(
    messageId: String, appearance: MailAppearance = .light, images: Bool = false, box: String? = nil
  ) async throws -> URLRequest {
    let request = request(
      .get, "/mail/messages/\(pathComponent(messageId))/document",
      query: [("appearance", appearance.rawValue), ("images", images ? "1" : nil), ("box", box)])
    return prepare(request)
  }

  /// Resolves a link the server gave (a signed attachment URL, absolute or a path) against the workspace.
  public nonisolated func resolve(_ link: String) -> URL? {
    URL(string: link, relativeTo: server)?.absoluteURL
  }

  // MARK: Requests

  enum Method: String {
    case get = "GET", post = "POST", put = "PUT", delete = "DELETE"
  }

  nonisolated func url(_ path: String, query: [(String, String?)] = []) -> URL {
    var string = apiBase.absoluteString + path
    let queryString = PercentEncoding.query(query)
    if !queryString.isEmpty { string += "?" + queryString }
    guard let url = URL(string: string) else {
      preconditionFailure("Not a URL: \(string)")
    }
    return url
  }

  nonisolated func request(_ method: Method, _ path: String, query: [(String, String?)] = []) -> URLRequest {
    var request = URLRequest(url: url(path, query: query))
    request.httpMethod = method.rawValue
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  nonisolated func request(
    _ method: Method, _ path: String, query: [(String, String?)] = [], json body: some Encodable
  ) throws -> URLRequest {
    var request = request(method, path, query: query)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder.workspace().encode(body)
    return request
  }

  /// Escapes an id for a path segment.
  public nonisolated func pathComponent(_ id: String) -> String {
    PercentEncoding.encode(id)
  }

  // MARK: Sending

  /// Attaches the bearer header.
  func prepare(_ request: URLRequest) -> URLRequest {
    var request = request
    if let credentials {
      request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
    }
    return request
  }

  /// Sends once; throws `APIError` on any failure, and signs out on `401`.
  func send(_ request: URLRequest, upload body: Data? = nil) async throws -> Data {
    let (data, response) = try await perform(prepare(request), upload: body)
    if response.statusCode == 401 { throw lose() }
    return try validated(data, response)
  }

  private func perform(_ request: URLRequest, upload body: Data?) async throws -> (Data, HTTPURLResponse) {
    let (data, response): (Data, URLResponse)
    if let body {
      (data, response) = try await session.upload(for: request, from: body)
    } else {
      (data, response) = try await session.data(for: request)
    }
    guard let http = response as? HTTPURLResponse else { throw APIError.badResponse(status: 0) }
    return (data, http)
  }

  private func download(_ request: URLRequest, bearer: Bool) async throws -> DownloadedFile {
    let (location, response) = try await session.download(for: bearer ? prepare(request) : request)
    guard let http = response as? HTTPURLResponse else { throw APIError.badResponse(status: 0) }
    if bearer, http.statusCode == 401 { throw lose() }
    guard (200..<300).contains(http.statusCode) else {
      let data = (try? Data(contentsOf: location)) ?? Data()
      throw problem(data, http)
    }
    let kept = FileManager.default.temporaryDirectory
      .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: kept, withIntermediateDirectories: true)
    let name = response.suggestedFilename ?? "file"
    let destination = kept.appending(path: name)
    try FileManager.default.moveItem(at: location, to: destination)
    return DownloadedFile(
      url: destination, contentType: http.value(forHTTPHeaderField: "Content-Type"),
      suggestedFilename: response.suggestedFilename)
  }

  /// The body of a `2xx` answer, unless it says `ok: false`; the problem otherwise.
  func validated(_ data: Data, _ response: HTTPURLResponse) throws -> Data {
    guard (200..<300).contains(response.statusCode) else { throw problem(data, response) }
    if let problem = try? JSONDecoder().decode(Problem.self, from: data), problem.ok == false {
      throw APIError.server(status: response.statusCode, message: problem.error ?? "The request failed.")
    }
    return data
  }

  nonisolated func problem(_ data: Data, _ response: HTTPURLResponse) -> APIError {
    if response.statusCode == 401 { return .unauthenticated }
    if let problem = try? JSONDecoder().decode(Problem.self, from: data), let message = problem.error {
      return .server(status: response.statusCode, message: message)
    }
    return .badResponse(status: response.statusCode)
  }

  nonisolated func decode<T: Decodable>(_ data: Data) throws -> T {
    do {
      return try JSONDecoder.workspace().decode(T.self, from: data)
    } catch let error as DecodingError {
      throw APIError.decoding(String(describing: error))
    }
  }

  // MARK: Losing the session

  /// The workspace refused the session: it goes from here and the store, and the handler runs
  /// once for it.
  func lose() -> APIError {
    if credentials != nil {
      credentials = nil
      try? store.clear()
      lostHandler?()
    }
    return .unauthenticated
  }
}
