import SwiftUI

/// A downloaded file, ready to go out through the system's share sheet.
struct DriveShareSheet: View {
  let file: DriveLocalFile
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      VStack(spacing: 16) {
        DriveKindTile(kind: kind, size: 72)
        Text(file.name)
          .font(.headline)
          .multilineTextAlignment(.center)
        Text(DriveFiles.size(of: file.url).formatted(.byteCount(style: .file)))
          .font(.subheadline)
          .foregroundStyle(.secondary)
        ShareLink(item: file.url) {
          Label("Share", systemImage: "square.and.arrow.up")
            .frame(maxWidth: .infinity)
        }
        .prominentAction()
        .padding(.top, 8)
      }
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium])
  }

  private var kind: DriveFileKind {
    DriveFileKind(contentType: file.contentType ?? "", name: file.name, isFolder: false)
  }
}
