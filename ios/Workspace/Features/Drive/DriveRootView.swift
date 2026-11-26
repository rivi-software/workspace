import SwiftUI
import WorkspaceKit

/// What a row pushes: a folder's listing or a file's page, with the name the row showed.
enum DriveDestination: Hashable {
  case folder(id: String, name: String)
  case file(id: String, name: String)
}

struct DriveDestinationView: View {
  let destination: DriveDestination

  var body: some View {
    switch destination {
    case .folder(let id, let name): DriveFolderView(folderId: id, name: name)
    case .file(let id, let name): DriveNodeView(nodeId: id, name: name)
    }
  }
}

/// The Drive tab: the root in one of its views, picked from the title's menu, and the start of
/// the stack folders and files push onto.
struct DriveRootView: View {
  @Environment(\.workspaceClient) private var client
  @State private var model = DriveModel()

  var body: some View {
    DriveListView(model: model)
      .navigationTitle(model.title)
      // The title menu only opens from an inline title, as Mail's.
      .navigationBarTitleDisplayMode(.inline)
      .toolbarTitleMenu {
        Picker("View", selection: viewSelection) {
          ForEach(DriveView.picks, id: \.self) { view in
            Label(view.title, systemImage: view.symbol)
              .tag(view)
          }
        }
        .pickerStyle(.inline)
      }
      .tabToolbar()
      .navigationDestination(for: DriveDestination.self) { destination in
        DriveDestinationView(destination: destination)
      }
      .task { await model.load(client) }
      .refreshable { await model.load(client) }
      .reloadsWhileOpen { await model.load(client) }
  }

  private var viewSelection: Binding<DriveView> {
    Binding(
      get: { model.view },
      set: { view in
        model.select(view: view)
        Task { await model.load(client) }
      })
  }
}
