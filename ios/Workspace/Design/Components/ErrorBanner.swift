import SwiftUI

/// The server's words when something failed, with a way to try again.
struct ErrorBanner: View {
  let message: String
  var retry: (() async -> Void)?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(Theme.red)
      Text(message)
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let retry {
        Button("Try again") { Task { await retry() } }
          .font(.subheadline.weight(.semibold))
      }
    }
    .padding(12)
    .background(Theme.redSoft, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .combine)
  }
}
