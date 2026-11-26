import SwiftUI

/// Nothing to show yet, in the system's unavailable-content layout.
struct EmptyState: View {
  let title: String
  let systemImage: String
  var description: String?

  var body: some View {
    ContentUnavailableView {
      Label(title, systemImage: systemImage)
    } description: {
      if let description {
        Text(description)
      }
    }
  }
}
