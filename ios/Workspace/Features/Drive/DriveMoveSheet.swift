import SwiftUI
import WorkspaceKit

/// Picks a new folder for a node: the person's own tree from My Drive down, folders only, with
/// "Move here" on the folder in view.
struct DriveMoveSheet: View {
  let row: DriveRow
  let move: @MainActor (String?) async -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      DriveMoveBrowser(folderId: nil, row: row, choose: choose, cancel: { dismiss() })
        .navigationDestination(for: DriveMoveTarget.self) { target in
          DriveMoveBrowser(folderId: target.id, row: row, choose: choose, cancel: { dismiss() })
        }
    }
  }

  private func choose(_ target: String?) async {
    await move(target)
    dismiss()
  }
}

/// A folder on the way down the tree.
struct DriveMoveTarget: Hashable {
  let id: String
}

/// One level of the person's folders, with the choice to move the node into this one.
struct DriveMoveBrowser: View {
  let folderId: String?
  let row: DriveRow
  let choose: @MainActor (String?) async -> Void
  let cancel: () -> Void
  @Environment(\.workspaceClient) private var client
  @State private var model: DriveModel
  @State private var moving = false

  init(
    folderId: String?, row: DriveRow, choose: @escaping @MainActor (String?) async -> Void,
    cancel: @escaping () -> Void
  ) {
    self.folderId = folderId
    self.row = row
    self.choose = choose
    self.cancel = cancel
    _model = State(initialValue: DriveModel(folderId: folderId))
  }

  var body: some View {
    LoadStateView(state: model.listing, retry: { await model.load(client) }) { listing in
      let folders = listing.rows.filter { $0.isFolder && $0.id != row.id }
      if folders.isEmpty {
        EmptyState(title: "No folders here", systemImage: "folder", description: "Move it here, or go back.")
      } else {
        List(folders) { folder in
          NavigationLink(value: DriveMoveTarget(id: folder.id)) {
            Label {
              Text(folder.name)
                .lineLimit(1)
            } icon: {
              Image(systemName: "folder.fill")
                .foregroundStyle(Theme.accent)
            }
          }
        }
        .listStyle(.plain)
      }
    }
    .navigationTitle(model.listing.value?.folder?.name ?? (folderId == nil ? "My Drive" : "Folder"))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Cancel", action: cancel)
      }
    }
    .safeAreaInset(edge: .bottom) {
      Button {
        Task {
          moving = true
          await choose(folderId)
          moving = false
        }
      } label: {
        Text(moving ? "Moving" : "Move here")
          .frame(maxWidth: .infinity)
      }
      .prominentAction()
      .disabled(moving || alreadyHere || model.listing.value == nil)
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
    }
    .task { await model.load(client) }
  }

  /// The node is in this folder already (both nil at the root).
  private var alreadyHere: Bool { row.parentId == folderId }
}
