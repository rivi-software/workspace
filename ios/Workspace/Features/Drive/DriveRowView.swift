import SwiftUI
import WorkspaceKit

/// One node in a listing: its kind's symbol, the name, the size and the moment, the markers.
struct DriveRowView: View {
  let row: DriveRow
  var showsOwner = false
  var isDownloading = false
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    HStack(spacing: 12) {
      DriveKindTile(kind: kind)
      VStack(alignment: .leading, spacing: 3) {
        Text(row.name)
          .font(.body.weight(row.isFolder ? .medium : .regular))
          .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
          // A file's name keeps its extension in sight; a folder's reads from the start.
          .truncationMode(row.isFolder ? .tail : .middle)
        HStack(spacing: 4) {
          if showsOwner {
            Text(row.owner.name)
              .lineLimit(1)
            Text("·")
          }
          Text(row.isFolder ? kind.label : row.size.formatted(.byteCount(style: .file)))
          Text("·")
          RelativeDateText(date: row.updatedAt)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .monospacedDigit()
      }
      Spacer(minLength: 8)
      HStack(spacing: 6) {
        if row.starred {
          Image(systemName: "star.fill")
            .foregroundStyle(Theme.star)
            .accessibilityLabel("Starred")
        }
        if row.shared {
          Image(systemName: "person.2")
            .accessibilityLabel("Shared")
        }
        if row.linked {
          Image(systemName: "link")
            .accessibilityLabel("Shared outside the workspace")
        }
        if isDownloading {
          ProgressView()
            .controlSize(.small)
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }

  private var kind: DriveFileKind { DriveFileKind(row) }
}

/// An upload on its way, at the top of its folder's listing: the name, how far it is, a cancel.
struct DriveUploadRow: View {
  let item: DriveUploads.Item
  let cancel: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      DriveKindTile(
        symbol: item.error == nil ? "arrow.up" : "exclamationmark.triangle",
        tint: item.error == nil ? Theme.accent : Theme.red,
        fill: item.error == nil ? Theme.accentSoft : Theme.redSoft)
      VStack(alignment: .leading, spacing: 4) {
        Text(item.name)
          .lineLimit(1)
        if let error = item.error {
          Text(error)
            .font(.caption)
            .foregroundStyle(Theme.red)
        } else if let progress = item.progress {
          ProgressView(value: progress)
        } else {
          ProgressView()
            .progressViewStyle(.linear)
        }
        Text(item.size.formatted(.byteCount(style: .file)))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 8)
      Button(action: cancel) {
        Image(systemName: "xmark.circle.fill")
          .foregroundStyle(.secondary)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(item.error == nil ? "Cancel upload" : "Dismiss")
    }
  }
}

/// A node's kind as a symbol on its soft tile, rounded as the mark's tile, so a listing reads by
/// kind before it reads by name.
struct DriveKindTile: View {
  let symbol: String
  let tint: Color
  let fill: Color
  @ScaledMetric private var side: CGFloat

  init(kind: DriveFileKind, size: CGFloat = 38) {
    self.init(symbol: kind.symbol, tint: kind.tint, fill: kind.fill, size: size)
  }

  init(symbol: String, tint: Color, fill: Color, size: CGFloat = 38) {
    self.symbol = symbol
    self.tint = tint
    self.fill = fill
    _side = ScaledMetric(wrappedValue: size, relativeTo: .body)
  }

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: side * 0.45, weight: .medium))
      .foregroundStyle(tint)
      .frame(width: side, height: side)
      .background(fill, in: .rect(cornerRadius: Theme.tileCorner(side), style: .continuous))
      .accessibilityHidden(true)
  }
}

/// What a row's context menu and swipes offer.
enum DriveRowAction {
  case open, rename, move, share, trash, restore, deleteForever
  case star(on: Bool)
}

/// The context menu and the swipe actions of a row, by where the row sits.
struct DriveRowActions: ViewModifier {
  let row: DriveRow
  let inTrash: Bool
  let canOpen: Bool
  let perform: (DriveRowAction) -> Void

  func body(content: Content) -> some View {
    content
      .contextMenu { menuItems }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) { trailingActions }
      .swipeActions(edge: .leading, allowsFullSwipe: true) { leadingActions }
  }

  @ViewBuilder private var menuItems: some View {
    if inTrash {
      Button("Restore", systemImage: "arrow.uturn.backward") { perform(.restore) }
      Button("Delete for good", systemImage: "trash.slash", role: .destructive) { perform(.deleteForever) }
    } else {
      if canOpen {
        Button("Open", systemImage: row.isFolder ? "folder" : "doc.text.magnifyingglass") { perform(.open) }
      }
      Button("Rename", systemImage: "pencil") { perform(.rename) }
      Button("Move", systemImage: "folder.badge.gearshape") { perform(.move) }
      Button(row.starred ? "Unstar" : "Star", systemImage: row.starred ? "star.slash" : "star") {
        perform(.star(on: !row.starred))
      }
      if !row.isFolder {
        Button("Download and share", systemImage: "square.and.arrow.up") { perform(.share) }
      }
      Divider()
      Button("Trash", systemImage: "trash", role: .destructive) { perform(.trash) }
    }
  }

  @ViewBuilder private var trailingActions: some View {
    if inTrash {
      Button("Delete", systemImage: "trash.slash", role: .destructive) { perform(.deleteForever) }
      Button("Restore", systemImage: "arrow.uturn.backward") { perform(.restore) }
        .tint(Theme.accent)
    } else {
      Button("Trash", systemImage: "trash", role: .destructive) { perform(.trash) }
    }
  }

  @ViewBuilder private var leadingActions: some View {
    if !inTrash {
      Button(row.starred ? "Unstar" : "Star", systemImage: row.starred ? "star.slash" : "star") {
        perform(.star(on: !row.starred))
      }
      .tint(Theme.star)
    }
  }
}
