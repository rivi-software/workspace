import SwiftUI
import WorkspaceKit

/// A correspondent as a small chip: their initials and name, the address for VoiceOver.
struct PersonChip: View {
  let address: Address

  var body: some View {
    HStack(spacing: 6) {
      AvatarView(name: address.displayName, size: 20)
      Text(address.displayName)
        .lineLimit(1)
    }
    .font(.subheadline)
    .padding(.leading, 3)
    .padding(.trailing, 10)
    .padding(.vertical, 3)
    .background(.quaternary, in: .capsule)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(address.typed)
  }
}
