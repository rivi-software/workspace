import Foundation
import WorkspaceKit

/// What the list shows: a folder of the sidebar, or a label's conversations.
enum MailView: Hashable {
  case folder(MailFolder)
  case label(LabelRef)

  var folder: MailFolder? {
    if case .folder(let folder) = self { return folder }
    return nil
  }

  var label: LabelRef? {
    if case .label(let label) = self { return label }
    return nil
  }

  var title: String {
    switch self {
    case .folder(let folder): folder.title
    case .label(let label): label.name
    }
  }

  /// Drafts and Scheduled list `DraftRow`s, not conversations.
  var listsDrafts: Bool {
    folder == .drafts || folder == .scheduled
  }

  /// The trash and Spam can be emptied.
  var canEmpty: Bool {
    folder == .trash || folder == .spam
  }
}

extension MailFolder {
  /// The folders of the menu, in the sidebar's order.
  static let listed: [MailFolder] = [
    .inbox, .starred, .snoozed, .sent, .scheduled, .drafts, .archive, .spam, .trash,
  ]

  var title: String {
    switch self {
    case .inbox: "Inbox"
    case .starred: "Starred"
    case .snoozed: "Snoozed"
    case .sent: "Sent"
    case .scheduled: "Scheduled"
    case .drafts: "Drafts"
    case .archive: "All mail"
    case .spam: "Spam"
    case .trash: "Trash"
    case .other(let raw): raw
    }
  }

  var systemImage: String {
    switch self {
    case .inbox: "tray"
    case .starred: "star"
    case .snoozed: "clock"
    case .sent: "paperplane"
    case .scheduled: "calendar.badge.clock"
    case .drafts: "doc"
    case .archive: "archivebox"
    case .spam: "xmark.bin"
    case .trash: "trash"
    case .other: "folder"
    }
  }
}

extension LabelColor {
  /// The palette, in the console's order.
  static let palette: [LabelColor] = [.gray, .red, .orange, .amber, .green, .teal, .blue, .violet, .pink]

  var title: String {
    switch self {
    case .gray: "Gray"
    case .red: "Red"
    case .orange: "Orange"
    case .amber: "Amber"
    case .green: "Green"
    case .teal: "Teal"
    case .blue: "Blue"
    case .violet: "Violet"
    case .pink: "Pink"
    case .other(let raw): raw
    }
  }
}

/// What the views read of a conversation, to tell whether an action takes it out of the one on
/// screen: the console's `ViewedThread`.
struct MailViewedThread {
  var folder: MailFolder
  var snoozed: Bool
  var starred: Bool
  var sent: Bool
  var unread: Bool
  var labelIds: Set<String>

  init(_ row: ListRow) {
    folder = row.folder
    snoozed = row.snoozedUntil != nil
    starred = row.starred
    sent = row.sent
    unread = row.unread
    labelIds = Set(row.labels.map(\.id))
  }
}

/// The console's `leavesView`: which view shows what, and what each intent does to a conversation.
enum MailViewRules {
  /// Whether `action` takes `thread` out of `view` (searched with `query`), so its row can go
  /// before the list reloads. A search is judged by where it looks, not by its terms.
  static func leaves(_ thread: MailViewedThread, after action: ThreadAction, in view: MailView, query: String) -> Bool {
    guard let after = after(thread, action) else { return true }
    if query.localizedCaseInsensitiveContains("in:anywhere") { return false }
    return !shows(view, after)
  }

  /// Whether `view` lists `thread`: the console's `viewCondition`.
  static func shows(_ view: MailView, _ thread: MailViewedThread) -> Bool {
    let junk = thread.folder == .trash || thread.folder == .spam
    switch view {
    case .label(let label):
      return thread.labelIds.contains(label.id) && !junk
    case .folder(let folder):
      switch folder {
      case .inbox: return thread.folder == .inbox && !thread.snoozed
      case .starred: return thread.starred && !junk
      case .snoozed: return thread.snoozed && !junk
      case .sent: return thread.sent && !junk
      case .archive: return !junk
      case .spam, .trash: return thread.folder == folder
      case .drafts, .scheduled, .other: return false
      }
    }
  }

  /// The conversation as the action leaves it; nil once it is deleted. The console's `afterEffect`.
  static func after(_ thread: MailViewedThread, _ action: ThreadAction) -> MailViewedThread? {
    var next = thread
    switch action.intent {
    case .archive:
      next.folder = .archive
      next.snoozed = false
    case .trash:
      next.folder = .trash
      next.snoozed = false
    case .spam:
      next.folder = .spam
      next.snoozed = false
    case .inbox:
      next.folder = .inbox
      next.snoozed = false
    case .snooze:
      next.folder = .inbox
      next.snoozed = action.until != nil
    case .unsnooze:
      next.snoozed = false
    case .mute:
      // A muted conversation leaves the inbox; its replies stay out of it.
      if thread.folder == .inbox {
        next.folder = .archive
        next.snoozed = false
      }
    case .star, .unstar:
      next.starred = action.intent == .star
    case .read, .unread:
      next.unread = action.intent == .unread
    case .label:
      if let id = action.labelId { next.labelIds.insert(id) }
    case .unlabel:
      if let id = action.labelId { next.labelIds.remove(id) }
    case .delete:
      return nil
    case .unmute, .other:
      break
    }
    return next
  }
}

/// The words for what an action did, on the undo capsule.
enum MailIntentWords {
  static func done(_ intent: ThreadIntent, count: Int) -> String {
    let what: String =
      switch intent {
      case .star: "starred"
      case .unstar: "unstarred"
      case .archive: "archived"
      case .trash: "moved to Trash"
      case .spam: "marked as spam"
      case .inbox: "moved to Inbox"
      case .read: "marked as read"
      case .unread: "marked as unread"
      case .delete: "deleted"
      case .mute: "muted"
      case .unmute: "unmuted"
      case .snooze: "snoozed"
      case .unsnooze: "unsnoozed"
      case .label: "labeled"
      case .unlabel: "unlabeled"
      case .other: "changed"
      }
    return count == 1 ? "Conversation \(what)" : "\(count) conversations \(what)"
  }
}
