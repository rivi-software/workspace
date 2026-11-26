import Foundation

/// A mail view: the folders of the list request, and the four a conversation can sit in.
public enum MailFolder: WireEnum {
  case inbox, starred, snoozed, sent, scheduled, drafts, archive, spam, trash
  case other(String)

  public static let known: [String: Self] = [
    "inbox": .inbox, "starred": .starred, "snoozed": .snoozed, "sent": .sent,
    "scheduled": .scheduled, "drafts": .drafts, "archive": .archive, "spam": .spam, "trash": .trash,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum Direction: WireEnum {
  case inbound, outbound
  case other(String)

  public static let known: [String: Self] = ["inbound": .inbound, "outbound": .outbound]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum DeliveryStatus: WireEnum {
  case received, sent, failed
  case other(String)

  public static let known: [String: Self] = ["received": .received, "sent": .sent, "failed": .failed]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

/// A row of the conversation list.
public struct ListRow: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var subject: String
  public var snippet: String
  /// "Ada Lovelace, Bob", or "me".
  public var people: String
  /// Messages in the conversation.
  public var count: Int
  public var unread: Bool
  public var starred: Bool
  public var hasAttachments: Bool
  public var muted: Bool
  /// The person wrote in it.
  public var sent: Bool
  public var lastMessageAt: Date
  public var snoozedUntil: Date?
  public var folder: MailFolder
  public var labels: [LabelRef]
}

/// A row of Drafts or Scheduled.
public struct DraftRow: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var to: String
  public var subject: String
  public var snippet: String
  public var updatedAt: Date
  public var scheduledAt: Date?
  public var sendError: String?
}

/// `GET /mail/threads`: `drafts` is filled for Drafts and Scheduled, `threads` for every other folder.
public struct ThreadList: Codable, Hashable, Sendable {
  public var folder: MailFolder
  public var q: String?
  public var page: Int
  public var pageSize: Int
  public var total: Int
  public var label: LabelRef?
  public var threads: [ListRow]
  public var drafts: [DraftRow]
}

public struct ThreadView: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var subject: String
  public var folder: MailFolder
  public var starred: Bool
  public var muted: Bool
  public var snoozedUntil: Date?
  public var messageCount: Int
  public var unreadCount: Int
  public var lastMessageAt: Date
  public var participants: [Address]
}

public struct Attachment: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var filename: String
  public var contentType: String
  public var size: Int64
  public var inline: Bool
  public var contentId: String?
  /// A signed link (six hours) that needs no token; `&download=1` serves it as an attachment.
  public var url: String
}

public struct MessageView: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var direction: Direction
  public var from: Address
  public var to: [Address]
  public var cc: [Address]
  public var bcc: [Address]
  public var replyTo: Address?
  public var subject: String
  /// The plain text, always.
  public var text: String
  /// The document endpoint answers for it.
  public var hasHtml: Bool
  /// The HTML loads images from the web, held back until `images=1`.
  public var remoteImages: Bool
  public var date: Date
  public var read: Bool
  public var deliveryStatus: DeliveryStatus
  public var deliveryError: String?
  /// The spam filter put it in Spam when it arrived.
  public var spam: Bool
  /// In a shared group inbox, the name of the member who wrote it; nil for every other message.
  public var sentBy: String?
  public var attachments: [Attachment]
}

/// `GET /mail/threads/:id`, oldest message first.
public struct ThreadDetail: Codable, Hashable, Sendable {
  public var thread: ThreadView
  public var labels: [LabelRef]
  public var messages: [MessageView]
}

/// The appearance a message's document is rendered for.
public enum MailAppearance: String, Sendable, Hashable {
  case light, dark
}

/// What an action on conversations does.
public enum ThreadIntent: WireEnum {
  case star, unstar, archive, trash, spam, inbox, read, unread, delete, mute, unmute
  case snooze, unsnooze, label, unlabel
  case other(String)

  public static let known: [String: Self] = [
    "star": .star, "unstar": .unstar, "archive": .archive, "trash": .trash, "spam": .spam,
    "inbox": .inbox, "read": .read, "unread": .unread, "delete": .delete, "mute": .mute,
    "unmute": .unmute, "snooze": .snooze, "unsnooze": .unsnooze, "label": .label,
    "unlabel": .unlabel,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

/// `POST /mail/threads/actions`: `until` with `snooze`, `labelId` with `label` and `unlabel`.
public struct ThreadAction: Encodable, Hashable, Sendable {
  public var ids: [String]
  public var intent: ThreadIntent
  public var until: Date?
  public var labelId: String?

  public init(ids: [String], intent: ThreadIntent, until: Date? = nil, labelId: String? = nil) {
    self.ids = ids
    self.intent = intent
    self.until = until
    self.labelId = labelId
  }
}

public struct ThreadActionResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var intent: ThreadIntent
  public var count: Int
  /// Pass it to `undo` to take the action back.
  public var undo: String?
}

/// `POST /mail/read-all`: the list whose conversations become read.
public struct ReadAllRequest: Encodable, Hashable, Sendable {
  public var folder: MailFolder?
  public var label: String?
  public var q: String?

  public init(folder: MailFolder? = nil, label: String? = nil, q: String? = nil) {
    self.folder = folder
    self.label = label
    self.q = q
  }
}

public enum ComposeMode: WireEnum {
  case new, reply, forward
  case other(String)

  public static let known: [String: Self] = ["new": .new, "reply": .reply, "forward": .forward]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

/// `GET /mail/compose?reply=<messageId>&mode=`.
public enum ReplyMode: String, Sendable, Hashable {
  case reply, all, forward
}

/// Where a composer starts from.
public enum ComposeSource: Hashable, Sendable {
  case blank
  case reply(messageId: String, mode: ReplyMode)
  case draft(id: String)
  case to(address: String)
}

public struct MailSignature: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var text: String
  public var html: String?
}

public struct PrefillFile: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var filename: String
  public var contentType: String
  public var size: Int64
}

public struct ComposePrefill: Codable, Hashable, Sendable {
  public var draftId: String?
  public var threadId: String?
  public var inReplyToId: String?
  public var mode: ComposeMode
  public var from: String
  public var to: String
  public var cc: String
  public var bcc: String
  public var subject: String
  public var text: String
  public var html: String
  public var signatureId: String?
  public var files: [PrefillFile]
}

/// `GET /mail/compose`.
public struct ComposeData: Codable, Hashable, Sendable {
  public var froms: [Address]
  public var signatures: [MailSignature]
  public var prefill: ComposePrefill
  public var undoSendSeconds: Int
}

/// A file sent with a message, its bytes as base64.
public struct OutgoingFile: Encodable, Hashable, Sendable {
  public var filename: String
  public var contentType: String
  public var base64: String

  public init(filename: String, contentType: String, data: Data) {
    self.filename = filename
    self.contentType = contentType
    base64 = data.base64EncodedString()
  }
}

/// `POST /mail/send`: `to`, `cc` and `bcc` are typed lists (`Ada <ada@acme.com>, bob@acme.com`),
/// `from` one of `ComposeData.froms`, the address alone or its `typed` form, `draftId` deletes the
/// draft once sent. The files together are at most 20 MB.
public struct SendRequest: Encodable, Hashable, Sendable {
  public var from: String
  public var to: String
  public var cc: String
  public var bcc: String
  public var subject: String
  public var text: String
  public var inReplyToId: String?
  public var signatureId: String?
  public var draftId: String?
  public var files: [OutgoingFile]?

  public init(
    from: String, to: String, cc: String = "", bcc: String = "", subject: String, text: String,
    inReplyToId: String? = nil, signatureId: String? = nil, draftId: String? = nil,
    files: [OutgoingFile]? = nil
  ) {
    self.from = from
    self.to = to
    self.cc = cc
    self.bcc = bcc
    self.subject = subject
    self.text = text
    self.inReplyToId = inReplyToId
    self.signatureId = signatureId
    self.draftId = draftId
    self.files = files
  }
}

public struct SendResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var threadId: String
}

/// `POST /mail/drafts`: with `id` it updates that draft.
public struct DraftRequest: Encodable, Hashable, Sendable {
  public var id: String?
  public var threadId: String?
  public var inReplyToId: String?
  public var mode: ComposeMode
  public var from: String
  public var to: String
  public var cc: String
  public var bcc: String
  public var subject: String
  public var text: String
  public var signatureId: String?

  public init(
    id: String? = nil, threadId: String? = nil, inReplyToId: String? = nil, mode: ComposeMode,
    from: String, to: String, cc: String = "", bcc: String = "", subject: String, text: String,
    signatureId: String? = nil
  ) {
    self.id = id
    self.threadId = threadId
    self.inReplyToId = inReplyToId
    self.mode = mode
    self.from = from
    self.to = to
    self.cc = cc
    self.bcc = bcc
    self.subject = subject
    self.text = text
    self.signatureId = signatureId
  }
}

public struct DraftResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var draftId: String
  public var savedAt: Date
}

public struct ContactsResponse: Codable, Hashable, Sendable {
  public var contacts: [Address]
}

public struct LabelResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var label: LabelRef
}

public struct NewLabel: Encodable, Hashable, Sendable {
  public var name: String
  public var color: LabelColor?

  public init(name: String, color: LabelColor? = nil) {
    self.name = name
    self.color = color
  }
}
