import Foundation

/// Every Mail call takes `box`: the id of a shared group inbox the person is in (`Me.mailboxes`),
/// whose mail it then reads and changes; nil for the person's own mailbox. The workspace answers
/// `404` for a box the person is not in.
extension WorkspaceClient {
  /// `GET /mail/threads`: a folder's page, a label's conversations (`folder` is then ignored),
  /// or a search in the search box's language (`from:`, `to:`, `subject:`, `has:attachment`,
  /// `is:unread`, `in:anywhere`, `label:`, `before:`, `after:`).
  public func threads(
    folder: MailFolder? = nil, label: String? = nil, q: String? = nil, page: Int? = nil,
    pageSize: Int? = nil, box: String? = nil
  ) async throws -> ThreadList {
    try await get(
      "/mail/threads",
      query: [
        ("folder", folder?.rawValue), ("label", label), ("q", q),
        ("page", page.map(String.init)), ("pageSize", pageSize.map(String.init)), ("box", box),
      ])
  }

  /// `GET /mail/threads/:id`; opening reads it unless `keepUnread`.
  public func thread(id: String, keepUnread: Bool = false, box: String? = nil) async throws -> ThreadDetail {
    try await get(
      "/mail/threads/\(pathComponent(id))",
      query: [("keepUnread", keepUnread ? "1" : nil), ("box", box)])
  }

  /// `POST /mail/threads/actions`.
  public func act(_ action: ThreadAction, box: String? = nil) async throws -> ThreadActionResult {
    try await post("/mail/threads/actions", query: [("box", box)], body: action)
  }

  /// `POST /mail/undo` with the `undo` an action answered.
  public func undo(_ undo: String, box: String? = nil) async throws -> OKResponse {
    try await post("/mail/undo", query: [("box", box)], body: UndoRequest(undo: undo))
  }

  /// `POST /mail/read-all`.
  public func readAll(_ list: ReadAllRequest, box: String? = nil) async throws -> OKResponse {
    try await post("/mail/read-all", query: [("box", box)], body: list)
  }

  /// `POST /mail/folders/:folder/empty`, for `trash` or `spam`.
  public func empty(folder: MailFolder, box: String? = nil) async throws -> CountResponse {
    try await post("/mail/folders/\(pathComponent(folder.rawValue))/empty", query: [("box", box)])
  }

  /// `GET /mail/compose`: what a composer starts from.
  public func compose(_ source: ComposeSource = .blank, box: String? = nil) async throws -> ComposeData {
    let query: [(String, String?)] =
      switch source {
      case .blank: []
      case .reply(let messageId, let mode): [("reply", messageId), ("mode", mode.rawValue)]
      case .draft(let id): [("draft", id)]
      case .to(let address): [("to", address)]
      }
    return try await get("/mail/compose", query: query + [("box", box)])
  }

  /// `POST /mail/send`.
  public func send(_ message: SendRequest, box: String? = nil) async throws -> SendResult {
    try await post("/mail/send", query: [("box", box)], body: message)
  }

  /// `POST /mail/drafts`.
  public func saveDraft(_ draft: DraftRequest, box: String? = nil) async throws -> DraftResult {
    try await post("/mail/drafts", query: [("box", box)], body: draft)
  }

  /// `DELETE /mail/drafts/:id`.
  public func deleteDraft(id: String, box: String? = nil) async throws -> OKResponse {
    try await delete("/mail/drafts/\(pathComponent(id))", query: [("box", box)])
  }

  /// `GET /mail/contacts?q=`: at most 8, most used first.
  public func contacts(q: String, box: String? = nil) async throws -> [Address] {
    let answer: ContactsResponse = try await get("/mail/contacts", query: [("q", q), ("box", box)])
    return answer.contacts
  }

  /// `POST /mail/labels`.
  public func createLabel(_ label: NewLabel, box: String? = nil) async throws -> LabelRef {
    let answer: LabelResult = try await post("/mail/labels", query: [("box", box)], body: label)
    return answer.label
  }

  /// An attachment's bytes through its signed link, as a download when `asAttachment`.
  public func download(attachment: Attachment, asAttachment: Bool = false) async throws -> DownloadedFile {
    guard var components = resolve(attachment.url).flatMap({ URLComponents(url: $0, resolvingAgainstBaseURL: false) })
    else { throw APIError.badResponse(status: 0) }
    if asAttachment {
      components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "download", value: "1")]
    }
    guard let url = components.url else { throw APIError.badResponse(status: 0) }
    return try await download(url: url)
  }
}

struct UndoRequest: Encodable, Sendable {
  var undo: String
}
