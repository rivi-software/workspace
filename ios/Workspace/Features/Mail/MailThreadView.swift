import SwiftUI
import WorkspaceKit

/// A conversation: its subject and labels, the messages oldest first, reply, reply all and
/// forward, and the actions on it in a menu.
struct MailThreadView: View {
  let threadId: String
  /// The shared group inbox it is in, or nil for the person's own mailbox.
  let box: String?
  /// Called once an action on the conversation succeeded, before the view pops.
  let onAction: (ThreadAction, ThreadActionResult) -> Void

  @Environment(\.workspaceClient) private var client
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @State private var model: MailThreadModel
  @State private var compose: MailComposeRequest?
  @State private var pickingSnooze = false
  @State private var pickingLabels = false
  @State private var confirmingDelete = false

  init(
    threadId: String, box: String? = nil, onAction: @escaping (ThreadAction, ThreadActionResult) -> Void
  ) {
    self.threadId = threadId
    self.box = box
    self.onAction = onAction
    _model = State(initialValue: MailThreadModel(threadId: threadId, box: box))
  }

  var body: some View {
    LoadStateView(state: model.detail, retry: { await model.load(client) }) { detail in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          if let error = model.actionError {
            ErrorBanner(message: error)
          }
          header(detail)
          ForEach(detail.messages) { message in
            MailMessageCard(
              message: message,
              box: box,
              expanded: model.expanded.contains(message.id),
              downloading: model.downloading,
              toggle: { withAnimation { model.toggle(message.id) } },
              open: { attachment in Task { await model.open(attachment, client: client) } })
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .background(Theme.canvas)
    }
    .navigationTitle(model.detail.value?.thread.subject ?? "")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .toolbar { toolbarItems }
    .task { await model.load(client) }
    .refreshable { await model.load(client) }
    .sheet(item: $compose) { request in
      MailComposeView(source: request.source, box: box) { Task { await model.load(client) } }
    }
    .sheet(isPresented: $pickingSnooze) {
      MailSnoozePicker { date in run(.intent(.snooze, until: date)) }
    }
    .sheet(isPresented: $pickingLabels) {
      MailLabelPicker(threadIds: [threadId], applied: model.facts?.labelIds ?? [], box: box) {
        Task { await model.load(client); await app.reloadMe() }
      }
    }
    .sheet(item: $model.preview) { file in
      MailAttachmentPreview(file: file)
    }
    .confirmationDialog("Delete for good?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete conversation", role: .destructive) { run(.intent(.delete)) }
    } message: {
      Text("What is deleted for good cannot be brought back.")
    }
  }

  private func header(_ detail: ThreadDetail) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(detail.thread.subject.isEmpty ? "(No subject)" : detail.thread.subject)
        .font(.title2.weight(.semibold))
      if !detail.labels.isEmpty || detail.thread.snoozedUntil != nil || detail.thread.muted {
        HStack(spacing: 6) {
          ForEach(detail.labels) { MailLabelChip(label: $0) }
          if let until = detail.thread.snoozedUntil {
            Label(MailSnooze.label(until), systemImage: "clock")
              .font(.caption)
              .foregroundStyle(Theme.amber)
          }
          if detail.thread.muted {
            Label("Muted", systemImage: "bell.slash")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }
    }
    .padding(.bottom, 4)
  }

  @ToolbarContentBuilder
  private var toolbarItems: some ToolbarContent {
    ToolbarItemGroup(placement: .bottomBar) {
      Button("Reply", systemImage: "arrowshape.turn.up.left") { reply(.reply) }
      Button("Reply all", systemImage: "arrowshape.turn.up.left.2") { reply(.all) }
      Button("Forward", systemImage: "arrowshape.turn.up.right") { reply(.forward) }
    }
    ToolbarSpacer(.flexible, placement: .bottomBar)
    ToolbarItem(placement: .bottomBar) {
      Menu {
        if let facts = model.facts {
          MailThreadMenuItems(facts: facts, labels: app.mailLabels, perform: run)
        }
      } label: {
        Label("More", systemImage: "ellipsis")
      }
      .disabled(model.facts == nil || model.isActing)
    }
  }

  /// The composer on the last message.
  private func reply(_ mode: ReplyMode) {
    guard let last = model.detail.value?.messages.last else { return }
    compose = MailComposeRequest(source: .reply(messageId: last.id, mode: mode))
  }

  private func run(_ action: MailMenuAction) {
    switch action {
    case .intent(let intent, let until, let labelId):
      Task {
        guard let outcome = await model.act(intent, until: until, labelId: labelId, client: client) else { return }
        onAction(outcome.0, outcome.1)
        await app.reloadMe()
        if Self.pops(intent) {
          dismiss()
        } else {
          await model.load(client)
        }
      }
    case .pickSnooze:
      pickingSnooze = true
    case .pickLabels:
      pickingLabels = true
    case .deleteForGood:
      confirmingDelete = true
    }
  }

  /// The actions after which the conversation is no longer the one to read: back to the list.
  private static func pops(_ intent: ThreadIntent) -> Bool {
    switch intent {
    case .archive, .trash, .spam, .inbox, .delete, .snooze, .unread, .mute: true
    case .star, .unstar, .read, .unmute, .unsnooze, .label, .unlabel, .other: false
    }
  }
}
