import SwiftUI
import WorkspaceKit

/// A listing: the rows of the root in one of its views, of a folder, or of a search, with the
/// uploads bound for it on top, the sort and the search in the bar, and the actions on each row.
/// While it shows, the create menu's new folders and uploads go to it where the person may write
/// (`CreateCenter`).
struct DriveListView: View {
  @Bindable var model: DriveModel
  @Environment(\.workspaceClient) private var client
  @Environment(CreateCenter.self) private var create: CreateCenter?
  @State private var renaming: DriveRow?
  @State private var moving: DriveRow?
  @State private var deleting: DriveRow?
  @State private var emptyingTrash = false
  @State private var sharing: DriveLocalFile?
  @State private var downloadingId: String?
  @State private var opening: DriveDestination?

  private var uploads: DriveUploads { .shared }

  var body: some View {
    LoadStateView(state: model.listing, retry: { await model.load(client) }) { listing in
      content(listing)
    }
    .searchable(text: $model.query, prompt: "Search by name")
    .onSubmit(of: .search) {
      model.submitSearch()
      reload()
    }
    .onChange(of: model.query) { _, text in
      guard text.isEmpty, model.isSearching else { return }
      model.clearSearch()
      reload()
    }
    .onChange(of: ChangeSignal.drive.version) { reload() }
    // The listing on top of the stack is the one shown: a folder pushed over the root, and the
    // root again once it pops.
    .onAppear { tellCreateMenu() }
    .onChange(of: model.listing.value?.canWrite) { tellCreateMenu() }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) { optionsMenu }
    }
    .navigationDestination(item: $opening) { DriveDestinationView(destination: $0) }
    .modifier(
      DriveListDialogs(
        model: model, renaming: $renaming, moving: $moving, deleting: $deleting,
        emptyingTrash: $emptyingTrash, sharing: $sharing))
  }

  // MARK: Content

  @ViewBuilder private func content(_ listing: DriveListing) -> some View {
    let pending = uploads.items(in: model.writeFolderId)
    if listing.rows.isEmpty, pending.isEmpty, model.actionError == nil {
      EmptyState(title: emptyTitle, systemImage: emptySymbol, description: emptyDescription)
    } else {
      List {
        if let error = model.actionError {
          Section {
            ErrorBanner(message: error)
              .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
              .listRowSeparator(.hidden)
          }
        }
        if !pending.isEmpty {
          Section("Uploading") {
            ForEach(pending) { item in
              DriveUploadRow(item: item) {
                if item.error == nil { uploads.cancel(item.id) } else { uploads.dismiss(item.id) }
              }
            }
          }
        }
        Section {
          ForEach(listing.rows) { row in
            rowView(row)
          }
        } footer: {
          if model.isRoot, !model.isSearching {
            Text("\(listing.used.formatted(.byteCount(style: .file))) used")
          }
        }
      }
      .listStyle(.plain)
    }
  }

  @ViewBuilder private func rowView(_ row: DriveRow) -> some View {
    let destination = destination(for: row)
    Group {
      if let destination {
        NavigationLink(value: destination) {
          DriveRowView(row: row, showsOwner: model.showsOwner, isDownloading: downloadingId == row.id)
        }
      } else {
        DriveRowView(row: row, showsOwner: model.showsOwner, isDownloading: downloadingId == row.id)
      }
    }
    .modifier(
      DriveRowActions(row: row, inTrash: model.isTrash, canOpen: destination != nil) { action in
        perform(action, on: row)
      })
  }

  /// A folder's listing or a file's page; a trashed folder opens nowhere.
  private func destination(for row: DriveRow) -> DriveDestination? {
    if row.isFolder {
      return model.isTrash ? nil : .folder(id: row.id, name: row.name)
    }
    return .file(id: row.id, name: row.name)
  }

  /// Where the create menu adds while this listing shows: here, if the person may write.
  private func tellCreateMenu() {
    create?.driveFolderId = model.listing.value?.canWrite == true ? model.writeFolderId : nil
  }

  private var optionsMenu: some View {
    Menu {
      Picker("Sort by", selection: sortSelection) {
        Text("Name").tag(DriveSort.name)
        Text("Updated").tag(DriveSort.updated)
        Text("Size").tag(DriveSort.size)
      }
      .pickerStyle(.inline)
      Picker("Order", selection: directionSelection) {
        Text("Ascending").tag(SortDirection.asc)
        Text("Descending").tag(SortDirection.desc)
      }
      .pickerStyle(.inline)
      if model.isTrash {
        Divider()
        Button("Empty trash", systemImage: "trash.slash", role: .destructive) { emptyingTrash = true }
      }
    } label: {
      Label("Sort and more", systemImage: "ellipsis.circle")
    }
  }

  // MARK: Actions

  private func perform(_ action: DriveRowAction, on row: DriveRow) {
    switch action {
    case .open: opening = destination(for: row)
    case .rename: renaming = row
    case .move: moving = row
    case .star(let on): Task { await model.setStar(row, on: on, client: client) }
    case .share: Task { await share(row) }
    case .trash: Task { await model.trash(row, client: client) }
    case .restore: Task { await model.restore(row, client: client) }
    case .deleteForever: deleting = row
    }
  }

  /// Downloads the file under its name, then offers the share sheet.
  private func share(_ row: DriveRow) async {
    downloadingId = row.id
    defer { downloadingId = nil }
    do {
      let download = try await client.downloadFile(id: row.id)
      sharing = try DriveFiles.keep(download, nodeId: row.id, name: row.name)
    } catch {
      model.actionError = failureMessage(error)
    }
  }

  private func reload() {
    Task { await model.load(client) }
  }

  private var sortSelection: Binding<DriveSort> {
    Binding(
      get: { model.effectiveSort },
      set: { sort in
        model.setSort(sort)
        reload()
      })
  }

  private var directionSelection: Binding<SortDirection> {
    Binding(
      get: { model.effectiveDirection },
      set: { direction in
        model.setDirection(direction)
        reload()
      })
  }

  // MARK: Empty

  private var emptyTitle: String {
    if model.isSearching { return "No results" }
    if !model.isRoot { return "This folder is empty" }
    switch model.view {
    case .mine: return "No files yet"
    case .shared: return "Nothing shared with you"
    case .recent: return "Nothing recent"
    case .starred: return "No starred files"
    case .trash: return "The trash is empty"
    case .other: return "Nothing here"
    }
  }

  private var emptySymbol: String {
    if model.isSearching { return "magnifyingglass" }
    if !model.isRoot { return "folder" }
    return model.view.symbol
  }

  private var emptyDescription: String? {
    if model.isSearching { return "Nothing is named like that." }
    if model.listing.value?.canWrite == true { return "Add a folder, or upload a photo or a file." }
    return nil
  }
}
