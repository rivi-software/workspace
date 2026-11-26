import QuickLook
import SwiftUI

/// The system's preview of a downloaded attachment, with a way to share the file.
struct MailAttachmentPreview: View {
  let file: MailAttachmentFile
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      MailQuickLook(url: file.url)
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle(file.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }
          }
          ToolbarItem(placement: .primaryAction) {
            ShareLink(item: file.url)
          }
        }
    }
  }
}

/// `QLPreviewController` on one file.
struct MailQuickLook: UIViewControllerRepresentable {
  let url: URL

  func makeCoordinator() -> Coordinator {
    Coordinator(url: url)
  }

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {
    guard context.coordinator.url != url else { return }
    context.coordinator.url = url
    controller.reloadData()
  }

  @MainActor
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL

    init(url: URL) {
      self.url = url
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
      1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
      url as NSURL
    }
  }
}
