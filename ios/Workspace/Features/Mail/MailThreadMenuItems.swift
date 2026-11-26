import SwiftUI
import WorkspaceKit

/// What the menus read of one conversation, or of a selection taken together.
struct MailThreadFacts {
  var ids: [String]
  var folder: MailFolder
  var starred: Bool
  var unread: Bool
  var muted: Bool
  var snoozed: Bool
  var labelIds: Set<String>

  init(_ row: ListRow) {
    ids = [row.id]
    folder = row.folder
    starred = row.starred
    unread = row.unread
    muted = row.muted
    snoozed = row.snoozedUntil != nil
    labelIds = Set(row.labels.map(\.id))
  }

  init(_ thread: ThreadView, labels: [LabelRef]) {
    ids = [thread.id]
    folder = thread.folder
    starred = thread.starred
    unread = thread.unreadCount > 0
    muted = thread.muted
    snoozed = thread.snoozedUntil != nil
    labelIds = Set(labels.map(\.id))
  }

  /// A selection: starred, muted and snoozed when every row is, unread when any is, the folder
  /// they share or `fallback`, the labels they all carry.
  init(rows: [ListRow], fallback: MailFolder) {
    ids = rows.map(\.id)
    let folders = Set(rows.map(\.folder))
    folder = folders.count == 1 ? (folders.first ?? fallback) : fallback
    starred = !rows.isEmpty && rows.allSatisfy(\.starred)
    unread = rows.contains { $0.unread }
    muted = !rows.isEmpty && rows.allSatisfy(\.muted)
    snoozed = !rows.isEmpty && rows.allSatisfy { $0.snoozedUntil != nil }
    var shared: Set<String>?
    for row in rows {
      let labels = Set(row.labels.map(\.id))
      shared = shared.map { $0.intersection(labels) } ?? labels
    }
    labelIds = shared ?? []
  }
}

/// What a menu asks for: an action on the server, or a sheet first.
enum MailMenuAction {
  case intent(ThreadIntent, until: Date? = nil, labelId: String? = nil)
  case pickSnooze
  case pickLabels
  case deleteForGood
}

/// The actions on a conversation, as a row's context menu, the selection bar's menu and the
/// conversation's own menu list them.
struct MailThreadMenuItems: View {
  let facts: MailThreadFacts
  /// The person's labels.
  let labels: [LabelRef]
  let perform: (MailMenuAction) -> Void

  var body: some View {
    Button(facts.starred ? "Unstar" : "Star", systemImage: facts.starred ? "star.slash" : "star") {
      perform(.intent(facts.starred ? .unstar : .star))
    }
    if facts.folder != .archive {
      Button("Archive", systemImage: "archivebox") { perform(.intent(.archive)) }
    }
    if facts.folder != .trash {
      Button("Move to Trash", systemImage: "trash") { perform(.intent(.trash)) }
    }
    if facts.folder == .spam {
      Button("Not spam", systemImage: "checkmark.shield") { perform(.intent(.inbox)) }
    } else {
      Button("Mark as spam", systemImage: "xmark.bin") { perform(.intent(.spam)) }
    }
    Button(
      facts.unread ? "Mark as read" : "Mark as unread",
      systemImage: facts.unread ? "envelope.open" : "envelope.badge"
    ) {
      perform(.intent(facts.unread ? .read : .unread))
    }
    Button(facts.muted ? "Unmute" : "Mute", systemImage: facts.muted ? "bell" : "bell.slash") {
      perform(.intent(facts.muted ? .unmute : .mute))
    }
    snoozeMenu
    labelsMenu
    if facts.folder != .inbox && facts.folder != .spam {
      Button("Move to Inbox", systemImage: "tray.and.arrow.down") { perform(.intent(.inbox)) }
    }
    if facts.folder == .trash || facts.folder == .spam {
      Divider()
      Button("Delete for good", systemImage: "trash.slash", role: .destructive) { perform(.deleteForGood) }
    }
  }

  private var snoozeMenu: some View {
    Menu("Snooze", systemImage: "clock") {
      ForEach(MailSnooze.presets()) { preset in
        Button {
          perform(.intent(.snooze, until: preset.date))
        } label: {
          Text(preset.title)
          Text(MailSnooze.label(preset.date))
        }
      }
      Button("Pick a date", systemImage: "calendar") { perform(.pickSnooze) }
      if facts.snoozed {
        Divider()
        Button("Unsnooze", systemImage: "clock.badge.xmark") { perform(.intent(.unsnooze)) }
      }
    }
  }

  private var labelsMenu: some View {
    Menu("Labels", systemImage: "tag") {
      ForEach(labels) { label in
        Toggle(
          label.name,
          isOn: Binding(
            get: { facts.labelIds.contains(label.id) },
            set: { on in perform(.intent(on ? .label : .unlabel, labelId: label.id)) })
        )
      }
      if !labels.isEmpty {
        Divider()
      }
      Button("Manage labels", systemImage: "slider.horizontal.3") { perform(.pickLabels) }
    }
  }
}
