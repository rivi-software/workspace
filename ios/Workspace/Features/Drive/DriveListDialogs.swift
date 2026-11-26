import SwiftUI
import WorkspaceKit

/// The dialogs a listing's actions open: the rename alert, the move sheet, the confirmations
/// for deleting and for emptying the trash, and the share sheet once a download landed.
struct DriveListDialogs: ViewModifier {
  let model: DriveModel
  @Binding var renaming: DriveRow?
  @Binding var moving: DriveRow?
  @Binding var deleting: DriveRow?
  @Binding var emptyingTrash: Bool
  @Binding var sharing: DriveLocalFile?
  @Environment(\.workspaceClient) private var client

  func body(content: Content) -> some View {
    content
      .modifier(
        DriveRenameAlert(row: $renaming) { row, name in
          await model.rename(row, to: name, client: client)
        }
      )
      .sheet(item: $moving) { row in
        DriveMoveSheet(row: row) { target in
          await model.move(row, to: target, client: client)
        }
      }
      .confirmationDialog(
        "Delete for good?", isPresented: isDeleting, titleVisibility: .visible, presenting: deleting
      ) { row in
        Button("Delete \(row.name)", role: .destructive) {
          Task { await model.deleteForever(row, client: client) }
        }
      } message: { _ in
        Text("It leaves the trash and cannot be brought back.")
      }
      .confirmationDialog("Empty the trash?", isPresented: $emptyingTrash, titleVisibility: .visible) {
        Button("Empty trash", role: .destructive) {
          Task { await model.emptyTrash(client: client) }
        }
      } message: {
        Text("Everything in it is deleted for good.")
      }
      .sheet(item: $sharing) { file in
        DriveShareSheet(file: file)
      }
  }

  private var isDeleting: Binding<Bool> {
    Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })
  }
}

/// An alert with the node's name in a text field; `rename` runs with the new name when it differs.
struct DriveRenameAlert: ViewModifier {
  @Binding var row: DriveRow?
  let rename: @MainActor (DriveRow, String) async -> Void
  @State private var name = ""

  func body(content: Content) -> some View {
    content
      .onChange(of: row) { _, row in
        if let row { name = row.name }
      }
      .alert("Rename", isPresented: isPresented, presenting: row) { row in
        TextField("Name", text: $name)
        Button("Cancel", role: .cancel) {}
        Button("Rename") {
          let new = name.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !new.isEmpty, new != row.name else { return }
          Task { await rename(row, new) }
        }
      } message: { row in
        Text(row.isFolder ? "A new name for the folder." : "A new name for the file.")
      }
  }

  private var isPresented: Binding<Bool> {
    Binding(get: { row != nil }, set: { if !$0 { row = nil } })
  }
}
