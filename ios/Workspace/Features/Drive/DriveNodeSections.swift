import SwiftUI
import WorkspaceKit

/// The file's facts, one row each.
struct DriveNodeDetailsSection: View {
  let details: NodeDetails

  var body: some View {
    Section("Details") {
      LabeledContent("Name", value: node.name)
      LabeledContent("Kind", value: kindLine)
      if !node.isFolder {
        LabeledContent("Size", value: node.size.formatted(.byteCount(style: .file)))
      }
      LabeledContent("Owner") {
        HStack(spacing: 6) {
          AvatarView(name: node.owner.name, size: 20)
          Text(node.owner.name)
        }
      }
      LabeledContent("Created", value: node.createdAt.formatted(date: .abbreviated, time: .shortened))
      LabeledContent("Updated", value: node.updatedAt.formatted(date: .abbreviated, time: .shortened))
      if let trashedAt = node.trashedAt {
        LabeledContent("Trashed", value: trashedAt.formatted(date: .abbreviated, time: .shortened))
      }
      LabeledContent("Location", value: location)
      LabeledContent("Starred", value: node.starred ? "Yes" : "No")
    }
  }

  private var node: DriveRow { details.node }

  private var kindLine: String {
    let kind = DriveFileKind(node)
    guard !node.contentType.isEmpty, kind != .folder else { return kind.label }
    return "\(kind.label) · \(node.contentType)"
  }

  /// The trail from the top the person sees, as the crumbs give it.
  private var location: String {
    let top = node.role == .owner ? "My Drive" : "Shared with me"
    let names = details.crumbs.map(\.name)
    return ([top] + names).joined(separator: " / ")
  }
}

/// Who the file is shared with: each person and their role, everyone in the workspace, the
/// link outside it; or that it is not shared.
struct DriveNodeSharingSection: View {
  let details: NodeDetails

  var body: some View {
    Section("Sharing") {
      if details.shares.isEmpty, !node.linked, !node.shared {
        Text("Not shared")
          .foregroundStyle(.secondary)
      }
      if node.role != .owner, node.shared {
        Label("Shared with you by \(node.owner.name)", systemImage: "person")
      }
      ForEach(Array(details.shares.enumerated()), id: \.offset) { _, share in
        LabeledContent {
          Text(share.role.title)
        } label: {
          if let person = share.person {
            HStack(spacing: 6) {
              AvatarView(name: person.name, size: 20)
              Text(person.name)
            }
          } else {
            Label("Everyone in the workspace", systemImage: "person.3")
          }
        }
      }
      if node.linked {
        Label("Shared outside the workspace", systemImage: "link")
      }
    }
  }

  private var node: DriveRow { details.node }
}
