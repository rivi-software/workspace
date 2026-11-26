import Foundation
import Testing

@testable import WorkspaceKit

struct WorkspaceClientTests {
  private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    func bump(_ key: String) -> Int {
      lock.withLock {
        counts[key, default: 0] += 1
        return counts[key] ?? 0
      }
    }
    func count(_ key: String) -> Int { lock.withLock { counts[key] ?? 0 } }
  }

  @Test func sendsTheSessionTokenAsABearer() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      call.bearer == "ses_token" ? .init(json: Samples.me) : .init(status: 401, json: "{}")
    }
    let (client, _) = try StubServer.client(host: host)
    let me = try await client.me()
    #expect(me.user.name == "Ada Lovelace")
    #expect(StubURLProtocol.calls(host: host).map(\.path) == ["/api/v1/me"])
  }

  @Test func signsOutOnceWhenTheWorkspaceEndsTheSession() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { _ in
      .init(status: 401, json: #"{"ok":false,"error":"Sign in again."}"#)
    }
    let (client, store) = try StubServer.client(host: host)
    let lost = Counter()
    await client.onAuthenticationLost { _ = lost.bump("lost") }
    await #expect(throws: APIError.unauthenticated) { _ = try await client.me() }
    await #expect(throws: APIError.unauthenticated) { _ = try await client.me() }
    #expect(lost.count("lost") == 1)
    #expect(try store.load() == nil)
    #expect(await client.isSignedIn == false)
    // Nothing goes out without a session: the second request carried no bearer.
    #expect(StubURLProtocol.calls(host: host).last?.bearer == nil)
  }

  @Test func keepsTheSessionOnAnotherFailure() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { _ in
      .init(status: 503, body: Data("down".utf8), contentType: "text/plain")
    }
    let (client, store) = try StubServer.client(host: host)
    await #expect(throws: APIError.badResponse(status: 503)) { _ = try await client.me() }
    #expect(try store.load()?.token == "ses_token")
  }

  @Test func readsOnlyTheSignInOfItsOwnServer() async throws {
    let store = MemoryTokenStore(
      Credentials(
        token: "ses_token", server: try #require(URL(string: "https://one.example.com")),
        email: "ada@example.com"))
    let other = WorkspaceClient(
      server: try #require(URL(string: "https://two.example.com")), tokenStore: store)
    #expect(await other.isSignedIn == false)
  }

  @Test func carriesTheServersWordsAndAnOkFalseBody() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      switch call.path {
      case "/api/v1/tasks/tk_1/done":
        return .init(json: #"{"ok":false,"error":"That task is not yours."}"#)
      case "/api/v1/mail/threads/missing":
        return .init(status: 404, json: #"{"ok":false,"error":"That conversation is not yours."}"#)
      case "/api/v1/drive":
        return .init(status: 502, body: Data("bad gateway".utf8), contentType: "text/html")
      default:
        return .init(status: 404, json: "{}")
      }
    }
    let (client, _) = try StubServer.client(host: host)
    await #expect(throws: APIError.server(status: 200, message: "That task is not yours.")) {
      _ = try await client.setTaskDone(id: "tk_1", done: true)
    }
    await #expect(throws: APIError.server(status: 404, message: "That conversation is not yours.")) {
      _ = try await client.thread(id: "missing")
    }
    await #expect(throws: APIError.badResponse(status: 502)) { _ = try await client.drive() }
    #expect(APIError.server(status: 404, message: "Nope").errorDescription == "Nope")
  }

  @Test func buildsPathsQueriesAndBodies() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      switch call.path {
      case "/api/v1/mail/threads": return .init(json: Samples.threadList)
      case "/api/v1/calendar": return .init(json: Samples.calendar)
      case "/api/v1/drive/nodes/move": return .init(json: #"{"ok":true,"count":2}"#)
      case "/api/v1/mail/threads/th%2F1": return .init(json: Samples.threadDetail)
      case "/api/v1/drive/upload": return .init(json: #"{"ok":true,"node":\#(Samples.node.components(separatedBy: "\"crumbs\"")[0].dropFirst(8).dropLast(1))}"#)
      default: return .init(status: 404, json: #"{"ok":false,"error":"Not found \#(call.path)"}"#)
      }
    }
    let (client, _) = try StubServer.client(host: host, token: "new")
    _ = try await client.threads(folder: .starred, q: "from:bob has:attachment", page: 2)
    _ = try await client.calendar(from: DayKey("2026-11-02"), to: DayKey("2026-11-10"))
    let moved = try await client.move(ids: ["dn_1", "dn_2"], targetId: nil)
    #expect(moved == 2)
    _ = try await client.thread(id: "th/1", keepUnread: true)
    let node = try await client.upload(Data("hello".utf8), folder: "dn_1", name: "a b.txt", contentType: "text/plain")
    #expect(node.id == "dn_2")
    let calls = StubURLProtocol.calls(host: host)
    #expect(calls[0].request.url?.query() == "folder=starred&q=from%3Abob%20has%3Aattachment&page=2")
    #expect(calls[1].request.url?.query() == "from=2026-11-02&to=2026-11-10")
    #expect(calls[2].request.httpMethod == "POST")
    #expect(String(decoding: calls[2].body, as: UTF8.self).contains(#""targetId":null"#))
    #expect(calls[2].request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(calls[3].request.url?.query() == "keepUnread=1")
    #expect(calls[4].request.httpMethod == "PUT")
    #expect(calls[4].request.url?.query() == "folder=dn_1&name=a%20b.txt")
    #expect(calls[4].request.value(forHTTPHeaderField: "Content-Type") == "text/plain")
    #if !canImport(FoundationNetworking)
      // Linux's Foundation hands an upload's body to no URLProtocol; Apple's does.
      #expect(calls[4].body == Data("hello".utf8))
    #endif
    let document = try await client.documentRequest(messageId: "m_1", appearance: .dark, images: true)
    #expect(document.url?.absoluteString == "https://\(host)/api/v1/mail/messages/m_1/document?appearance=dark&images=1")
    #expect(document.value(forHTTPHeaderField: "Authorization") == "Bearer new")
  }

  @Test func carriesTheSharedInboxOnEveryMailCall() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      switch call.path {
      case "/api/v1/mail/threads": return .init(json: Samples.threadList)
      case "/api/v1/mail/threads/actions": return .init(json: #"{"ok":true,"intent":"archive","count":1,"undo":null}"#)
      default: return .init(json: #"{"ok":true}"#)
      }
    }
    let (client, _) = try StubServer.client(host: host)
    _ = try await client.threads(folder: .inbox, box: "usr_help")
    _ = try await client.act(ThreadAction(ids: ["th_1"], intent: .archive), box: "usr_help")
    _ = try await client.deleteDraft(id: "dr_1", box: "usr_help")
    _ = try await client.threads(folder: .inbox)
    let document = try await client.documentRequest(messageId: "m_1", box: "usr_help")
    let queries = StubURLProtocol.calls(host: host).map { $0.request.url?.query() }
    #expect(queries == ["folder=inbox&box=usr_help", "box=usr_help", "box=usr_help", "folder=inbox"])
    #expect(document.url?.query() == "appearance=light&box=usr_help")
  }
}
