import Foundation
import Observation
import UniformTypeIdentifiers
import WorkspaceKit

/// A file picked for a message, its bytes read.
struct MailPickedFile: Sendable {
  let name: String
  let contentType: String
  let data: Data
}

/// A file going with the message.
struct MailOutgoingAttachment: Identifiable, Hashable {
  let id: UUID
  let name: String
  let size: Int
  let file: OutgoingFile

  init(_ picked: MailPickedFile) {
    id = UUID()
    name = picked.name
    size = picked.data.count
    file = OutgoingFile(filename: picked.name, contentType: picked.contentType, data: picked.data)
  }
}

/// A composer: what it started from, the fields, the files, and the send or the draft.
@Observable @MainActor
final class MailComposeModel {
  /// The files together, as the API allows.
  static let maxAttachmentBytes = 20_000_000

  private struct Fields: Equatable {
    var from = ""
    var to = ""
    var cc = ""
    var bcc = ""
    var subject = ""
    var text = ""
    var signatureId: String?
  }

  let source: ComposeSource
  var data: LoadState<ComposeData> = .idle
  var from = ""
  var to = ""
  var cc = ""
  var bcc = ""
  var subject = ""
  var text = ""
  var signatureId: String?
  var showCcBcc = false
  private(set) var attachments: [MailOutgoingAttachment] = []
  private(set) var isSending = false
  private(set) var isSaving = false
  /// What the server said went wrong, or why a file was refused.
  var error: String?
  private var start: Fields?

  /// The shared group inbox it is written in, or nil for the person's own mailbox: what it sends
  /// from, and where the draft is kept.
  let box: String?

  init(source: ComposeSource, box: String? = nil) {
    self.source = source
    self.box = box
  }

  var title: String {
    switch data.value?.prefill.mode {
    case .reply: "Reply"
    case .forward: "Forward"
    case .new, .other, nil: "New message"
    }
  }

  var hasRecipient: Bool {
    [to, cc, bcc].contains { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  }

  /// Something was typed, or a file added, since the composer opened.
  var isDirty: Bool {
    guard let start else { return false }
    return fields != start || !attachments.isEmpty
  }

  /// The draft this composer edits, when it came from one.
  var draftId: String? { data.value?.prefill.draftId }

  var attachmentBytes: Int { attachments.reduce(0) { $0 + $1.size } }

  private var fields: Fields {
    Fields(from: from, to: to, cc: cc, bcc: bcc, subject: subject, text: text, signatureId: signatureId)
  }

  func load(_ client: WorkspaceClient) async {
    data.begin()
    do {
      let answer = try await client.compose(source, box: box)
      apply(answer)
      data.finish(answer)
    } catch {
      data.fail(error)
    }
  }

  private func apply(_ answer: ComposeData) {
    let prefill = answer.prefill
    // The From picker's values are the typed forms; the prefill may name the address alone.
    let match = answer.froms.first { $0.email == prefill.from || $0.typed == prefill.from }
    from = match?.typed ?? (prefill.from.isEmpty ? answer.froms.first?.typed ?? "" : prefill.from)
    to = prefill.to
    cc = prefill.cc
    bcc = prefill.bcc
    subject = prefill.subject
    text = prefill.text
    signatureId = prefill.signatureId
    showCcBcc = !prefill.cc.isEmpty || !prefill.bcc.isEmpty
    start = fields
  }

  // MARK: Files

  /// Keeps a picked file, unless the files together would pass 20 MB.
  func add(_ picked: MailPickedFile) {
    guard attachmentBytes + picked.data.count <= Self.maxAttachmentBytes else {
      error = "Attachments can be 20 MB together; \(picked.name) does not fit."
      return
    }
    attachments.append(MailOutgoingAttachment(picked))
  }

  func remove(_ id: UUID) {
    attachments.removeAll { $0.id == id }
  }

  /// Reads a picked file's bytes, off the main actor.
  nonisolated static func read(_ url: URL) async throws -> MailPickedFile {
    let scoped = url.startAccessingSecurityScopedResource()
    defer {
      if scoped { url.stopAccessingSecurityScopedResource() }
    }
    let data = try Data(contentsOf: url)
    let type =
      (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
      ?? UTType(filenameExtension: url.pathExtension)
    return MailPickedFile(
      name: url.lastPathComponent, contentType: type?.preferredMIMEType ?? "application/octet-stream",
      data: data)
  }

  // MARK: Sending and drafts

  /// Sends; true once it went. The error stays on the sheet otherwise.
  func send(_ client: WorkspaceClient) async -> Bool {
    guard let answer = data.value, !isSending else { return false }
    error = nil
    isSending = true
    defer { isSending = false }
    let request = SendRequest(
      from: from, to: to, cc: cc, bcc: bcc, subject: subject, text: text,
      inReplyToId: answer.prefill.inReplyToId, signatureId: signatureId, draftId: draftId,
      files: attachments.isEmpty ? nil : attachments.map(\.file))
    do {
      _ = try await client.send(request, box: box)
      return true
    } catch {
      self.error = failureMessage(error)
      return false
    }
  }

  /// Saves the fields as a draft, the one this came from when it did.
  func saveDraft(_ client: WorkspaceClient) async -> Bool {
    guard let answer = data.value, !isSaving else { return false }
    error = nil
    isSaving = true
    defer { isSaving = false }
    let request = DraftRequest(
      id: draftId, threadId: answer.prefill.threadId, inReplyToId: answer.prefill.inReplyToId,
      mode: answer.prefill.mode, from: from, to: to, cc: cc, bcc: bcc, subject: subject, text: text,
      signatureId: signatureId)
    do {
      _ = try await client.saveDraft(request, box: box)
      return true
    } catch {
      self.error = failureMessage(error)
      return false
    }
  }

  /// Deletes the draft this came from; nothing to do without one.
  func deleteDraft(_ client: WorkspaceClient) async -> Bool {
    guard let draftId else { return true }
    error = nil
    do {
      _ = try await client.deleteDraft(id: draftId, box: box)
      return true
    } catch {
      self.error = failureMessage(error)
      return false
    }
  }
}
