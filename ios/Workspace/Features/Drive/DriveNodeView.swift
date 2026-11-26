import QuickLook
import SwiftUI
import WorkspaceKit

/// A file's page: the preview on top, then its details and who it is shared with, with the star,
/// the share and the changes in the bar.
struct DriveNodeView: View {
  let nodeId: String
  /// The name the row showed, the title until the details are in.
  var name: String?
  @Environment(\.workspaceClient) private var client
  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss
  @State private var model: DriveNodeModel
  @State private var image: UIImage?
  @State private var previewURL: URL?
  @State private var viewingImage = false
  @State private var renaming: DriveRow?
  @State private var moving: DriveRow?
  @State private var confirmingDelete = false
  @State private var sharing: DriveLocalFile?

  init(nodeId: String, name: String? = nil) {
    self.nodeId = nodeId
    self.name = name
    _model = State(initialValue: DriveNodeModel(nodeId: nodeId))
  }

  var body: some View {
    LoadStateView(state: model.details, retry: { await model.load(client) }) { details in
      List {
        if let error = model.actionError {
          Section {
            ErrorBanner(message: error)
              .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
              .listRowBackground(Color.clear)
          }
        }
        Section {
          DriveNodeHeader(details: details, file: model.file, image: image) {
            Task { await open(details) }
          }
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
        }
        DriveNodeDetailsSection(details: details)
        DriveNodeSharingSection(details: details)
      }
      .listStyle(.insetGrouped)
    }
    .navigationTitle(model.node?.name ?? name ?? "File")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { toolbar }
    .task {
      await model.load(client)
      if model.downloadsOnItsOwn { await model.download(client) }
    }
    .refreshable { await model.load(client) }
    .onChange(of: model.file.value) { _, file in
      guard let file, model.details.value?.preview == .image else {
        image = nil
        return
      }
      image = UIImage(contentsOfFile: file.url.path)
    }
    .onChange(of: model.left) { _, left in
      if left { dismiss() }
    }
    .quickLookPreview($previewURL)
    .fullScreenCover(isPresented: $viewingImage) {
      if let image {
        DriveImageViewer(image: image, name: model.node?.name ?? "")
      }
    }
    .sheet(item: $sharing) { file in
      DriveShareSheet(file: file)
    }
    .modifier(
      DriveRenameAlert(row: $renaming) { _, name in
        await model.rename(to: name, client: client)
      }
    )
    .sheet(item: $moving) { row in
      DriveMoveSheet(row: row) { target in
        await model.move(to: target, client: client)
      }
    }
    .confirmationDialog("Delete for good?", isPresented: $confirmingDelete, titleVisibility: .visible) {
      Button("Delete", role: .destructive) {
        Task { await model.deleteForever(client: client) }
      }
    } message: {
      Text("It leaves the trash and cannot be brought back.")
    }
  }

  // MARK: The preview

  /// Downloads when needed, then shows the file: the image viewer, or QuickLook for the rest.
  private func open(_ details: NodeDetails) async {
    guard let file = await model.download(client) else { return }
    if details.preview == .image, image == nil {
      image = UIImage(contentsOfFile: file.url.path)
    }
    if details.preview == .image, image != nil {
      viewingImage = true
    } else {
      previewURL = file.url
    }
  }

  // MARK: The bar

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    if let node = model.node {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button(node.starred ? "Unstar" : "Star", systemImage: node.starred ? "star.fill" : "star") {
          Task { await model.setStar(on: !node.starred, client: client) }
        }
        .tint(node.starred ? Theme.star : nil)
        shareButton
        Menu {
          menuItems(node)
        } label: {
          Label("More", systemImage: "ellipsis.circle")
        }
      }
    }
  }

  @ViewBuilder private var shareButton: some View {
    if let file = model.file.value {
      ShareLink(item: file.url) {
        Label("Share", systemImage: "square.and.arrow.up")
      }
    } else {
      Button("Share", systemImage: "square.and.arrow.up") {
        Task {
          if let file = await model.download(client) { sharing = file }
        }
      }
      .disabled(model.file.isLoading)
    }
  }

  @ViewBuilder private func menuItems(_ node: DriveRow) -> some View {
    if node.trashedAt != nil {
      Button("Restore", systemImage: "arrow.uturn.backward") {
        Task { await model.restore(client: client) }
      }
      Button("Delete for good", systemImage: "trash.slash", role: .destructive) { confirmingDelete = true }
    } else {
      Button("Rename", systemImage: "pencil") { renaming = node }
      Button("Move", systemImage: "folder.badge.gearshape") { moving = node }
      Button("Trash", systemImage: "trash", role: .destructive) {
        Task { await model.trash(client: client) }
      }
    }
    Divider()
    Button("Open in the workspace", systemImage: "safari") {
      openURL(client.server.appending(path: "drive/d/\(nodeId)"))
    }
  }
}

/// The top of the page: the image once it is here, else the kind's symbol with the size and a
/// way to see the file.
struct DriveNodeHeader: View {
  let details: NodeDetails
  let file: LoadState<DriveLocalFile>
  let image: UIImage?
  let open: () -> Void

  var body: some View {
    VStack(spacing: 12) {
      if let image {
        Button(action: open) {
          Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(maxWidth: .infinity, maxHeight: 320)
            .clipShape(.rect(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open the image")
      } else {
        DriveKindTile(kind: kind, size: 88)
          .padding(.top, 8)
        Text("\(kind.label) · \(details.node.size.formatted(.byteCount(style: .file)))")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        switch file {
        case .loading:
          ProgressView("Downloading")
            .font(.subheadline)
        case .failed(let message, _):
          Text(message)
            .font(.caption)
            .foregroundStyle(Theme.red)
            .multilineTextAlignment(.center)
          Button("Try again", action: open)
        case .idle, .loaded:
          Button(file.value == nil ? "Download and preview" : "Preview", systemImage: "eye", action: open)
            .prominentAction()
        }
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 12)
  }

  private var kind: DriveFileKind { DriveFileKind(details.node) }
}
