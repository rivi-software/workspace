import SwiftUI
import WorkspaceKit

/// A folder's listing, pushed from its row, with the trail above it as the subtitle and the create
/// menu, whose Drive items add here while it shows.
struct DriveFolderView: View {
  let folderId: String
  /// The name the row showed, the title until the listing is in.
  let name: String
  @Environment(\.workspaceClient) private var client
  @State private var model: DriveModel

  init(folderId: String, name: String = "Folder") {
    self.folderId = folderId
    self.name = name
    _model = State(initialValue: DriveModel(folderId: folderId))
  }

  var body: some View {
    DriveListView(model: model)
      .navigationTitle(model.listing.value?.folder?.name ?? name)
      .navigationSubtitle(trail)
      .toolbar {
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) {
          CreateMenu()
        }
      }
      .task { await model.load(client) }
      .refreshable { await model.load(client) }
  }

  /// Where the folder sits: "My Drive / Contracts", or "Shared with me / …" for another's.
  private var trail: String {
    guard let listing = model.listing.value else { return "" }
    let top = listing.folder?.role == .owner ? "My Drive" : "Shared with me"
    return ([top] + listing.crumbs.map(\.name)).joined(separator: " / ")
  }
}
