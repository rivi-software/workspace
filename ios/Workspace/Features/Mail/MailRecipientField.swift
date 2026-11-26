import SwiftUI
import WorkspaceKit

/// A To, Cc or Bcc field: a typed list, with the contacts that match what is being typed under
/// it; a tap puts one in.
struct MailRecipientField: View {
  private static let debounce: Duration = .milliseconds(250)

  let title: String
  @Binding var text: String
  @Environment(\.workspaceClient) private var client
  @State private var suggestions: [Address] = []
  @State private var search: Task<Void, Never>?
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .foregroundStyle(.secondary)
          .frame(minWidth: 36, alignment: .leading)
        TextField("", text: $text, axis: .vertical)
          .keyboardType(.emailAddress)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .focused($focused)
          .accessibilityLabel(title)
      }
      if focused && !suggestions.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(suggestions, id: \.email) { contact in
            Button {
              insert(contact)
            } label: {
              HStack(spacing: 8) {
                AvatarView(name: contact.displayName, size: 24)
                VStack(alignment: .leading, spacing: 1) {
                  Text(contact.displayName)
                    .lineLimit(1)
                  if contact.name != nil {
                    Text(contact.email)
                      .font(.caption)
                      .foregroundStyle(.secondary)
                      .lineLimit(1)
                  }
                }
              }
              .font(.subheadline)
              .padding(.vertical, 6)
              .frame(maxWidth: .infinity, alignment: .leading)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(contact.typed)
          }
        }
      }
    }
    .onChange(of: text) { _, _ in schedule() }
    .onChange(of: focused) { _, isFocused in
      if !isFocused {
        search?.cancel()
        suggestions = []
      }
    }
  }

  /// What is being typed: the part after the last comma.
  private var term: String {
    let tail = text.split(separator: ",", omittingEmptySubsequences: false).last.map(String.init) ?? text
    return tail.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func schedule() {
    search?.cancel()
    let term = term
    guard !term.isEmpty else {
      suggestions = []
      return
    }
    search = Task {
      try? await Task.sleep(for: Self.debounce)
      guard !Task.isCancelled else { return }
      let found = (try? await client.contacts(q: term)) ?? []
      guard !Task.isCancelled else { return }
      suggestions = found
    }
  }

  /// Replaces what is being typed with the contact, and starts the next entry.
  private func insert(_ contact: Address) {
    var parts = text.split(separator: ",", omittingEmptySubsequences: false).map(String.init)
    if parts.isEmpty { parts = [""] }
    parts[parts.count - 1] = " " + contact.typed
    let joined = parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    text = joined.joined(separator: ", ") + ", "
    suggestions = []
  }
}
