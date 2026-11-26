import SwiftUI
import WorkspaceKit

/// The glass bar over a selection: archive, trash, read, star, and the rest in a menu. Sits in a
/// `GlassGroup` with its neighbors.
struct MailSelectionBar: View {
  let facts: MailThreadFacts
  let labels: [LabelRef]
  let perform: (MailMenuAction) -> Void

  var body: some View {
    HStack(spacing: 0) {
      GlassIconButton(systemImage: "archivebox", label: "Archive") { perform(.intent(.archive)) }
      Spacer(minLength: 8)
      GlassIconButton(
        systemImage: facts.folder == .trash ? "trash.slash" : "trash",
        label: facts.folder == .trash ? "Delete for good" : "Move to Trash"
      ) {
        perform(facts.folder == .trash ? .deleteForGood : .intent(.trash))
      }
      Spacer(minLength: 8)
      GlassIconButton(
        systemImage: facts.unread ? "envelope.open" : "envelope.badge",
        label: facts.unread ? "Mark as read" : "Mark as unread"
      ) {
        perform(.intent(facts.unread ? .read : .unread))
      }
      Spacer(minLength: 8)
      GlassIconButton(
        systemImage: facts.starred ? "star.slash" : "star", label: facts.starred ? "Unstar" : "Star"
      ) {
        perform(.intent(facts.starred ? .unstar : .star))
      }
      Spacer(minLength: 8)
      Menu {
        MailThreadMenuItems(facts: facts, labels: labels, perform: perform)
      } label: {
        Image(systemName: "ellipsis")
          .font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.glass)
      .accessibilityLabel("More actions")
    }
    .disabled(facts.ids.isEmpty)
  }
}

/// What the last action did, and a way to take it back, in a glass capsule.
struct MailUndoCapsule: View {
  let undo: MailUndo
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Text(undo.words)
          .lineLimit(1)
        Text("Undo")
          .fontWeight(.semibold)
          .foregroundStyle(Theme.accent)
      }
      .font(.subheadline)
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
    }
    .buttonStyle(.glass)
    .accessibilityLabel("Undo: \(undo.words)")
  }
}
