import Foundation
import Observation
import WorkspaceKit

/// A downloaded attachment, ready for a preview.
struct MailAttachmentFile: Identifiable, Hashable {
  let id: UUID
  let url: URL
  let name: String

  init(url: URL, name: String) {
    id = UUID()
    self.url = url
    self.name = name
  }
}

/// One conversation: its messages, which of them show whole, and the attachment on its way to a
/// preview.
@Observable @MainActor
final class MailThreadModel {
  let threadId: String
  /// The shared group inbox it is in, or nil for the person's own mailbox.
  let box: String?
  var detail: LoadState<ThreadDetail> = .idle
  /// The messages shown whole; the rest are one line.
  private(set) var expanded: Set<String> = []
  /// What the last action or download said went wrong.
  var actionError: String?
  private(set) var isActing = false
  var preview: MailAttachmentFile?
  private(set) var downloading: String?
  private var hasOpened = false

  init(threadId: String, box: String? = nil) {
    self.threadId = threadId
    self.box = box
  }

  var facts: MailThreadFacts? {
    detail.value.map { MailThreadFacts($0.thread, labels: $0.labels) }
  }

  /// Reads the conversation; the server marks it read.
  func load(_ client: WorkspaceClient) async {
    detail.begin()
    do {
      let answer = try await client.thread(id: threadId, box: box)
      if !hasOpened {
        expanded = Self.openAtFirst(answer.messages)
        hasOpened = true
      }
      detail.finish(answer)
    } catch {
      detail.fail(error)
    }
  }

  /// Every message when there are two or fewer; else the last one and the unread ones.
  private static func openAtFirst(_ messages: [MessageView]) -> Set<String> {
    if messages.count <= 2 { return Set(messages.map(\.id)) }
    var open = Set(messages.filter { !$0.read }.map(\.id))
    if let last = messages.last { open.insert(last.id) }
    return open
  }

  func toggle(_ messageId: String) {
    if expanded.contains(messageId) {
      expanded.remove(messageId)
    } else {
      expanded.insert(messageId)
    }
  }

  /// Does `intent` to this conversation: the action and its result, or nil when the server refused.
  func act(
    _ intent: ThreadIntent, until: Date? = nil, labelId: String? = nil, client: WorkspaceClient
  ) async -> (ThreadAction, ThreadActionResult)? {
    let action = ThreadAction(ids: [threadId], intent: intent, until: until, labelId: labelId)
    actionError = nil
    isActing = true
    defer { isActing = false }
    do {
      return (action, try await client.act(action, box: box))
    } catch {
      actionError = failureMessage(error)
      return nil
    }
  }

  /// Downloads an attachment to a temporary file under its own name, for the preview.
  func open(_ attachment: Attachment, client: WorkspaceClient) async {
    guard downloading == nil else { return }
    downloading = attachment.id
    defer { downloading = nil }
    do {
      let file = try await client.download(attachment: attachment)
      preview = MailAttachmentFile(url: Self.named(file.url, as: attachment.filename), name: attachment.filename)
    } catch {
      actionError = failureMessage(error)
    }
  }

  /// The file under the attachment's own name, so the preview knows its kind; the download's
  /// name when the move fails.
  private static func named(_ url: URL, as filename: String) -> URL {
    let name = filename.replacingOccurrences(of: "/", with: "-")
    guard !name.isEmpty, url.lastPathComponent != name else { return url }
    let destination = url.deletingLastPathComponent().appending(path: name)
    do {
      try FileManager.default.moveItem(at: url, to: destination)
      return destination
    } catch {
      return url
    }
  }
}
