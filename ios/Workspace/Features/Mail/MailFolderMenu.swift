import SwiftUI
import WorkspaceKit

/// The menu on the list's title: the mailboxes when the person is in a shared group inbox, the
/// folders and the mailbox's labels with their counts, then what the whole view can do.
struct MailFolderMenu: View {
  @Environment(AppModel.self) private var app
  let model: MailModel
  /// Another mailbox: nil for the person's own, else a shared inbox's id.
  let selectMailbox: (String?) -> Void
  let select: (MailView) -> Void
  let readAll: () -> Void
  let empty: () -> Void

  var body: some View {
    if let me = app.me, !me.mailboxes.isEmpty {
      Picker("Mailbox", selection: Binding(get: { app.box }, set: { selectMailbox($0) })) {
        Section("Mailboxes") {
          mailbox(me.user.name, unread: me.counts.inboxUnread, systemImage: "person")
            .tag(String?.none)
          ForEach(me.mailboxes) { box in
            mailbox(box.name, unread: box.counts.inboxUnread, systemImage: "person.2")
              .tag(String?.some(box.id))
          }
        }
      }
      .pickerStyle(.inline)
    }
    Picker("Folder", selection: Binding(get: { model.view }, set: { select($0) })) {
      Section {
        ForEach(MailFolder.listed, id: \.self) { folder in
          Label {
            Text(folder.title)
            if let detail = detail(for: folder) {
              Text(detail)
            }
          } icon: {
            Image(systemName: folder.systemImage)
          }
          .tag(MailView.folder(folder))
        }
      }
      if !labels.isEmpty {
        Section("Labels") {
          ForEach(labels) { label in
            Label {
              Text(label.name)
              if let unread = app.mailCounts?.labels[label.id], unread > 0 {
                Text("\(unread) unread")
              }
            } icon: {
              Image(systemName: "tag")
            }
            .tag(MailView.label(label))
          }
        }
      }
    }
    .pickerStyle(.inline)
    Divider()
    if !model.listsDrafts {
      Button("Mark all as read", systemImage: "envelope.open") { readAll() }
    }
    if model.view.canEmpty {
      Button("Empty \(model.view.title)", systemImage: "trash.slash", role: .destructive) { empty() }
    }
  }

  private var labels: [LabelRef] { app.mailLabels }

  private func mailbox(_ name: String, unread: Int, systemImage: String) -> some View {
    Label {
      Text(name)
      if unread > 0 {
        Text("\(unread) unread")
      }
    } icon: {
      Image(systemName: systemImage)
    }
  }

  /// "12 unread" beside Inbox, Spam and a label; the count beside Snoozed, Drafts and Scheduled.
  private func detail(for folder: MailFolder) -> String? {
    guard let counts = app.mailCounts else { return nil }
    switch folder {
    case .inbox: return counts.inboxUnread > 0 ? "\(counts.inboxUnread) unread" : nil
    case .spam: return counts.spamUnread > 0 ? "\(counts.spamUnread) unread" : nil
    case .snoozed: return counts.snoozed > 0 ? "\(counts.snoozed)" : nil
    case .drafts: return counts.drafts > 0 ? "\(counts.drafts)" : nil
    case .scheduled: return counts.scheduled > 0 ? "\(counts.scheduled)" : nil
    case .starred, .sent, .archive, .trash, .other: return nil
    }
  }
}
