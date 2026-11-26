import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import WorkspaceKit

/// What the create menu's Drive items ask for, and the folder it goes to, "" for My Drive.
struct DriveAddRequest: Equatable {
  enum Kind: Equatable {
    case folder, photos, files
  }

  let kind: Kind
  let folderId: String
}

extension View {
  /// The create menu's Drive items: a new folder's name, the photo library, or the document
  /// picker, with the uploads going to `DriveUploads`. Each listing on show reads itself again
  /// when what was added is in (`ChangeSignal.drive`).
  func driveAddFlows(_ request: Binding<DriveAddRequest?>) -> some View {
    modifier(DriveAddFlows(request: request))
  }
}

private struct DriveAddFlows: ViewModifier {
  @Binding var request: DriveAddRequest?
  @Environment(\.workspaceClient) private var client
  @Environment(AppModel.self) private var app
  /// The folder what is added goes to, from the last request.
  @State private var folderId = ""
  @State private var namingFolder = false
  @State private var folderName = ""
  @State private var pickingPhotos = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var pickingFiles = false
  @State private var failure: String?

  func body(content: Content) -> some View {
    content
      .onChange(of: request) { _, request in
        guard let request else { return }
        self.request = nil
        start(request)
      }
      .alert("New folder", isPresented: $namingFolder) {
        TextField("Name", text: $folderName)
        Button("Cancel", role: .cancel) {}
        Button("Create") {
          let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !name.isEmpty else { return }
          Task { await createFolder(named: name) }
        }
      } message: {
        Text("A name for the folder.")
      }
      .photosPicker(
        isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 20,
        matching: .any(of: [.images, .videos]))
      .onChange(of: photoItems) { _, items in
        guard !items.isEmpty else { return }
        photoItems = []
        Task { await upload(photos: items) }
      }
      .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) {
        result in
        switch result {
        case .success(let urls): upload(files: urls)
        case .failure(let error): failure = failureMessage(error)
        }
      }
      .alert("Nothing added", isPresented: hasFailure) {
        Button("OK") {}
      } message: {
        Text(failure ?? "")
      }
  }

  private func start(_ request: DriveAddRequest) {
    folderId = request.folderId
    switch request.kind {
    case .folder:
      folderName = ""
      namingFolder = true
    case .photos:
      pickingPhotos = true
    case .files:
      pickingFiles = true
    }
  }

  private func createFolder(named name: String) async {
    do {
      _ = try await client.createFolder(parentId: folderId.isEmpty ? nil : folderId, name: name)
      ChangeSignal.drive.bump()
    } catch {
      failure = failureMessage(error)
    }
  }

  private func upload(photos items: [PhotosPickerItem]) async {
    var files: [DrivePickedFile] = []
    for item in items {
      do {
        files.append(try await DrivePickedFile.picked(item))
      } catch {
        failure = failureMessage(error)
      }
    }
    start(files)
  }

  private func upload(files urls: [URL]) {
    var files: [DrivePickedFile] = []
    for url in urls {
      do {
        files.append(try DrivePickedFile.imported(url))
      } catch {
        failure = failureMessage(error)
      }
    }
    start(files)
  }

  private func start(_ files: [DrivePickedFile]) {
    guard !files.isEmpty else { return }
    DriveUploads.shared.start(files, folderId: folderId, client: client) {
      ChangeSignal.drive.bump()
      await app.reloadMe()
    }
  }

  private var hasFailure: Binding<Bool> {
    Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })
  }
}
