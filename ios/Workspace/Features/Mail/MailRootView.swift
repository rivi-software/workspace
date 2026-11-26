import SwiftUI
import WorkspaceKit

/// A conversation to push from the list.
struct MailThreadDestination: Hashable {
  let id: String
}

/// A composer to open, and where it starts from.
struct MailComposeRequest: Identifiable {
  let id = UUID()
  let source: ComposeSource
}

/// Conversations a sheet acts on, with the labels they carry.
struct MailTargets: Identifiable {
  let id = UUID()
  let ids: [String]
  var labelIds: Set<String> = []
}

/// The list: the folder's conversations, the folder menu on the title, search, swipes, a context
/// menu per row, a selection with its floating bar, and the undo capsule. A new message starts
/// from the create menu (`tabToolbar`).
struct MailRootView: View {
  @Environment(\.workspaceClient) private var client
  @Environment(AppModel.self) private var app
  @State private var model = MailModel()
  @State private var editMode: EditMode = .inactive
  @State private var compose: MailComposeRequest?
  @State private var snoozing: MailTargets?
  @State private var labeling: MailTargets?
  @State private var deleting: MailTargets?
  @State private var confirmingEmpty = false

  var body: some View {
    content
      .navigationTitle(editMode.isEditing ? "\(model.selection.count) selected" : title)
      // The title menu only opens from an inline title: a large one, at the top of the list,
      // shows no chevron and ignores a tap.
      .navigationBarTitleDisplayMode(.inline)
      .toolbarTitleMenu {
        MailFolderMenu(
          model: model,
          selectMailbox: { box in app.showMailbox(box) },
          select: { view in Task { await model.show(view, client) } },
          readAll: { Task { await model.readAll(client); await app.reloadMe() } },
          empty: { confirmingEmpty = true })
      }
      .toolbar { toolbarItems }
      .tabToolbar()
      .searchable(text: $model.searchText, prompt: "Search, or from:ada has:attachment")
      .onSubmit(of: .search) { Task { await model.search(client) } }
      .onChange(of: model.searchText) { _, text in
        if text.isEmpty { Task { await model.clearSearch(client) } }
      }
      .environment(\.editMode, $editMode)
      .navigationDestination(for: MailThreadDestination.self) { destination in
        MailThreadView(threadId: destination.id, box: model.box) { action, result in
          model.note(result, for: action)
        }
      }
      .sheet(item: $compose) { request in
        MailComposeView(source: request.source, box: model.box) { Task { await model.load(client) } }
      }
      .sheet(item: $snoozing) { targets in
        MailSnoozePicker { date in run(.intent(.snooze, until: date), on: targets.ids) }
      }
      .sheet(item: $labeling) { targets in
        MailLabelPicker(threadIds: targets.ids, applied: targets.labelIds, box: model.box) {
          Task { await model.load(client); await app.reloadMe() }
        }
      }
      .confirmationDialog(
        "Delete for good?", isPresented: isDeleting, titleVisibility: .visible, presenting: deleting
      ) { targets in
        Button(targets.ids.count == 1 ? "Delete conversation" : "Delete \(targets.ids.count) conversations", role: .destructive) {
          run(.intent(.delete), on: targets.ids)
        }
      } message: { _ in
        Text("What is deleted for good cannot be brought back.")
      }
      .confirmationDialog("Empty \(model.view.title)?", isPresented: $confirmingEmpty, titleVisibility: .visible) {
        Button("Empty \(model.view.title)", role: .destructive) {
          Task { await model.empty(client); await app.reloadMe() }
        }
      } message: {
        Text("Every conversation in it is deleted for good.")
      }
      .task {
        if model.box != app.box {
          await model.showMailbox(app.box, client)
        } else {
          await model.load(client)
        }
      }
      // Another mailbox from the title menu, or the shared inbox on show is gone (the person left
      // the group): the list follows.
      .onChange(of: app.box) { _, box in Task { await model.showMailbox(box, client) } }
      .refreshable { await model.load(client) }
      .reloadsWhileOpen { await model.load(client) }
      // A message sent or a draft kept from the create menu.
      .onChange(of: ChangeSignal.mail.version) { Task { await model.load(client) } }
  }

  // MARK: The list

  private var content: some View {
    LoadStateView(state: model.list, retry: { await model.load(client) }) { _ in
      if model.isEmpty {
        ScrollView {
          EmptyState(title: emptyTitle, systemImage: "envelope", description: emptyDescription)
            .padding(.top, 80)
        }
      } else {
        rows
      }
    }
    .safeAreaInset(edge: .bottom) { bottom }
  }

  private var rows: some View {
    // Bound only while selecting: outside it a tap on a row would select it on its way into the
    // conversation, and the row would stay highlighted after coming back.
    List(selection: editMode.isEditing ? $model.selection : nil) {
      if let error = model.actionError {
        ErrorBanner(message: error)
          .listRowSeparator(.hidden)
      }
      if model.listsDrafts {
        ForEach(model.drafts) { draft in
          Button {
            compose = MailComposeRequest(source: .draft(id: draft.id))
          } label: {
            MailDraftRow(draft: draft)
          }
          .buttonStyle(.plain)
          .onAppear { if model.isLast(draft.id) { Task { await model.loadMore(client) } } }
        }
      } else {
        ForEach(model.threads) { row in
          threadRow(row)
            .onAppear { if model.isLast(row.id) { Task { await model.loadMore(client) } } }
        }
      }
      if model.isLoadingMore {
        WorkspaceLoader(size: 18)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 8)
          .listRowSeparator(.hidden)
      }
    }
    .listStyle(.plain)
  }

  private func threadRow(_ row: ListRow) -> some View {
    NavigationLink(value: MailThreadDestination(id: row.id)) {
      MailThreadRow(row: row, inSnoozed: model.view.folder == .snoozed)
    }
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      Button(row.unread ? "Read" : "Unread", systemImage: row.unread ? "envelope.open" : "envelope.badge") {
        run(.intent(row.unread ? .read : .unread), on: [row.id])
      }
      .tint(Theme.accent)
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if row.folder == .trash {
        Button("Delete", systemImage: "trash.slash", role: .destructive) { run(.deleteForGood, on: [row.id]) }
      } else {
        Button("Trash", systemImage: "trash", role: .destructive) { run(.intent(.trash), on: [row.id]) }
      }
      Button("Archive", systemImage: "archivebox") { run(.intent(.archive), on: [row.id]) }
        .tint(Theme.muted)
      Button(row.starred ? "Unstar" : "Star", systemImage: row.starred ? "star.slash" : "star") {
        run(.intent(row.starred ? .unstar : .star), on: [row.id])
      }
      .tint(Theme.star)
    }
    .contextMenu {
      MailThreadMenuItems(facts: MailThreadFacts(row), labels: labels) { action in
        run(action, on: [row.id], labelIds: Set(row.labels.map(\.id)))
      }
    }
  }

  // MARK: What floats

  /// The selection's bar while selecting, else the undo capsule after an action; nothing
  /// otherwise, since a new message starts from the create menu at the top right.
  private var bottom: some View {
    VStack(spacing: 0) {
      if editMode.isEditing {
        GlassGroup {
          MailSelectionBar(facts: model.facts(for: model.selection), labels: labels) { action in
            let facts = model.facts(for: model.selection)
            run(action, on: facts.ids, labelIds: facts.labelIds)
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
      } else if let undo = model.undo {
        MailUndoCapsule(undo: undo) { Task { await model.undoLast(client); await app.reloadMe() } }
          .padding(.horizontal, 16)
          .padding(.bottom, 16)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.default, value: model.undo)
    .animation(.default, value: editMode)
  }

  @ToolbarContentBuilder
  private var toolbarItems: some ToolbarContent {
    if !model.listsDrafts {
      ToolbarItem(placement: .topBarTrailing) {
        Button(editMode.isEditing ? "Done" : "Select") { toggleEditing() }
      }
    }
  }

  // MARK: Actions

  private var labels: [LabelRef] { app.mailLabels }

  /// The folder's title; in a shared group inbox its name, beside the folder unless it is the
  /// inbox.
  private var title: String {
    guard let mailbox = app.mailbox else { return model.title }
    return model.title == MailView.folder(.inbox).title ? mailbox.name : "\(model.title) · \(mailbox.name)"
  }

  private var isDeleting: Binding<Bool> {
    Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
  }

  private var emptyTitle: String {
    if !model.query.isEmpty { return "No results" }
    return model.listsDrafts ? "No drafts" : "No conversations"
  }

  private var emptyDescription: String {
    model.query.isEmpty ? "Nothing in \(model.view.title) right now." : "Nothing matches \(model.query)."
  }

  private func toggleEditing() {
    withAnimation {
      if editMode.isEditing {
        editMode = .inactive
        model.selection = []
      } else {
        editMode = .active
      }
    }
  }

  /// Runs what a menu, a swipe or the bar asked for on `ids`.
  private func run(_ action: MailMenuAction, on ids: [String], labelIds: Set<String> = []) {
    switch action {
    case .intent(let intent, let until, let labelId):
      Task {
        await model.act(intent, on: ids, until: until, labelId: labelId, client: client)
        await app.reloadMe()
      }
    case .pickSnooze:
      snoozing = MailTargets(ids: ids)
    case .pickLabels:
      labeling = MailTargets(ids: ids, labelIds: labelIds)
    case .deleteForGood:
      deleting = MailTargets(ids: ids)
    }
  }
}
