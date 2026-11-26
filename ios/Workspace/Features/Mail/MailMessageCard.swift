import SwiftUI
import WorkspaceKit

/// One message as a card: who wrote it, to whom, when, its body and its files; one line when it is
/// not expanded.
struct MailMessageCard: View {
  let message: MessageView
  /// The shared group inbox it is in, or nil for the person's own mailbox.
  var box: String?
  let expanded: Bool
  /// The attachment on its way to a preview, when one is.
  let downloading: String?
  let toggle: () -> Void
  let open: (Attachment) -> Void
  @State private var showingRecipients = false
  @State private var loadingImages = false

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      if expanded {
        if showingRecipients {
          recipients
        }
        delivery
        MailMessageBody(message: message, box: box, images: loadingImages)
        if message.remoteImages && !loadingImages {
          Button("Load images", systemImage: "photo") { loadingImages = true }
            .font(.subheadline)
            .buttonStyle(.bordered)
        }
        let files = message.attachments.filter { !$0.inline }
        if !files.isEmpty {
          attachments(files)
        }
      }
    }
    .padding(14)
    .background(Theme.elevated, in: .rect(cornerRadius: 16))
    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.border))
  }

  private var header: some View {
    HStack(alignment: .top, spacing: 10) {
      AvatarView(name: message.from.displayName, size: 36)
      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .firstTextBaseline) {
          Text(message.from.displayName)
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
          Spacer(minLength: 8)
          if expanded {
            Text(message.date.formatted(date: .abbreviated, time: .shortened))
              .font(.caption)
              .foregroundStyle(.secondary)
          } else {
            RelativeDateText(date: message.date)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
        if let sentBy = message.sentBy {
          // In a shared group inbox, which member wrote it, as the console shows.
          Text("Sent by \(sentBy)")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        if expanded {
          if message.from.name != nil {
            Text(message.from.email)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
          Button {
            withAnimation { showingRecipients.toggle() }
          } label: {
            HStack(spacing: 4) {
              Text(recipientsLine)
                .lineLimit(1)
              Image(systemName: "chevron.down")
                .rotationEffect(showingRecipients ? .degrees(180) : .zero)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
          }
          .accessibilityLabel(showingRecipients ? "Hide recipients" : "Show recipients")
        } else {
          Text(snippet)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
    }
    .contentShape(Rectangle())
    .onTapGesture(perform: toggle)
    .accessibilityAddTraits(.isButton)
    .accessibilityAction(named: expanded ? "Collapse" : "Expand", toggle)
  }

  private var recipientsLine: String {
    var parts: [String] = []
    if !message.to.isEmpty { parts.append("to \(message.to.map(\.displayName).joined(separator: ", "))") }
    if !message.cc.isEmpty { parts.append("cc \(message.cc.map(\.displayName).joined(separator: ", "))") }
    if !message.bcc.isEmpty { parts.append("bcc \(message.bcc.map(\.displayName).joined(separator: ", "))") }
    return parts.isEmpty ? "No recipients" : parts.joined(separator: ", ")
  }

  /// The first line of the text, for the collapsed card.
  private var snippet: String {
    let line = message.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    return line.trimmingCharacters(in: .whitespaces)
  }

  private var recipients: some View {
    VStack(alignment: .leading, spacing: 8) {
      recipientRow("To", message.to)
      if !message.cc.isEmpty { recipientRow("Cc", message.cc) }
      if !message.bcc.isEmpty { recipientRow("Bcc", message.bcc) }
      if let replyTo = message.replyTo { recipientRow("Reply to", [replyTo]) }
    }
    .padding(10)
    .background(Theme.canvas, in: .rect(cornerRadius: 10))
  }

  private func recipientRow(_ title: String, _ people: [Address]) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      ForEach(people, id: \.email) { person in
        HStack(spacing: 6) {
          PersonChip(address: person)
          if person.name != nil {
            Text(person.email)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var delivery: some View {
    if let error = message.deliveryError {
      Label(error, systemImage: "exclamationmark.triangle.fill")
        .font(.subheadline)
        .foregroundStyle(Theme.red)
    } else if message.deliveryStatus == .failed {
      Label("Not delivered", systemImage: "exclamationmark.triangle.fill")
        .font(.subheadline)
        .foregroundStyle(Theme.red)
    }
  }

  private func attachments(_ files: [Attachment]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(files) { file in
        Button {
          open(file)
        } label: {
          HStack(spacing: 8) {
            Image(systemName: Self.icon(for: file.contentType))
              .foregroundStyle(Theme.accent)
            VStack(alignment: .leading, spacing: 1) {
              Text(file.filename)
                .lineLimit(1)
              Text(file.size.formatted(.byteCount(style: .file)))
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if downloading == file.id {
              ProgressView()
            }
          }
          .font(.subheadline)
          .padding(.horizontal, 10)
          .padding(.vertical, 8)
          .background(.quaternary, in: .rect(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(downloading != nil)
        .accessibilityLabel("\(file.filename), \(file.size.formatted(.byteCount(style: .file)))")
        .accessibilityHint("Opens a preview")
      }
    }
  }

  private static func icon(for contentType: String) -> String {
    if contentType.hasPrefix("image/") { return "photo" }
    if contentType == "application/pdf" { return "doc.richtext" }
    if contentType.hasPrefix("video/") { return "film" }
    if contentType.hasPrefix("audio/") { return "waveform" }
    return "doc"
  }
}

/// The message's body: its HTML document in a web view, or its text.
struct MailMessageBody: View {
  let message: MessageView
  /// The shared group inbox it is in, or nil for the person's own mailbox.
  var box: String?
  /// Load the images from the web too.
  let images: Bool
  @Environment(\.workspaceClient) private var client
  @Environment(\.colorScheme) private var colorScheme
  @State private var request: URLRequest?
  @State private var height: CGFloat = 120
  @State private var failure: String?

  private struct Key: Hashable {
    let appearance: MailAppearance
    let images: Bool
    let messageId: String
  }

  var body: some View {
    if message.hasHtml {
      Group {
        if let request {
          MailHTMLView(request: request, height: $height)
            .frame(height: height)
        } else if let failure {
          VStack(alignment: .leading, spacing: 8) {
            Text(failure)
              .font(.subheadline)
              .foregroundStyle(Theme.red)
            text
          }
        } else {
          ProgressView()
            .frame(maxWidth: .infinity)
            .frame(height: 80)
        }
      }
      .task(id: key) { await prepare() }
    } else {
      text
    }
  }

  private var text: some View {
    Text(message.text)
      .font(.body)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var key: Key {
    Key(appearance: colorScheme == .dark ? .dark : .light, images: images, messageId: message.id)
  }

  private func prepare() async {
    failure = nil
    do {
      request = try await client.documentRequest(
        messageId: message.id, appearance: key.appearance, images: images, box: box)
    } catch {
      request = nil
      failure = failureMessage(error)
    }
  }
}
