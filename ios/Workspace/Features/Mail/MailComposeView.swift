import PhotosUI
import SwiftUI
import WorkspaceKit

/// The composer, in a sheet: from, the recipients with their suggestions, the subject, the body
/// over the quoted original, a signature, the files, and Send.
struct MailComposeView: View {
  let source: ComposeSource
  /// Called once the message was sent, or a draft saved or deleted: the caller reloads its list.
  let onSent: () -> Void

  @Environment(\.workspaceClient) private var client
  @Environment(\.dismiss) private var dismiss
  @State private var model: MailComposeModel
  @State private var askingToClose = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var importingFiles = false

  init(source: ComposeSource, box: String? = nil, onSent: @escaping () -> Void) {
    self.source = source
    self.onSent = onSent
    _model = State(initialValue: MailComposeModel(source: source, box: box))
  }

  var body: some View {
    NavigationStack {
      LoadStateView(state: model.data, retry: { await model.load(client) }) { data in
        form(data)
      }
      .navigationTitle(model.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { close() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button {
            Task { await send() }
          } label: {
            if model.isSending {
              ProgressView()
            } else {
              Label("Send", systemImage: "paperplane.fill")
            }
          }
          .prominentAction()
          .disabled(!model.hasRecipient || model.isSending || model.data.value == nil)
        }
      }
      .confirmationDialog("Keep this message?", isPresented: $askingToClose, titleVisibility: .visible) {
        Button("Save draft") { Task { await saveAndClose() } }
        Button(model.draftId == nil ? "Discard" : "Delete draft", role: .destructive) {
          Task { await deleteAndClose() }
        }
        Button("Keep editing", role: .cancel) {}
      }
      .fileImporter(
        isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
      ) { result in
        Task { await addFiles(result) }
      }
      .onChange(of: photoItems) { _, items in
        guard !items.isEmpty else { return }
        Task { await addPhotos(items) }
      }
      .interactiveDismissDisabled(model.isDirty)
      .task { await model.load(client) }
    }
  }

  private func form(_ data: ComposeData) -> some View {
    Form {
      if let error = model.error {
        ErrorBanner(message: error)
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
      }
      Section {
        if data.froms.count > 1 {
          Picker("From", selection: $model.from) {
            ForEach(data.froms, id: \.email) { address in
              Text(address.typed).tag(address.typed)
            }
          }
        }
        MailRecipientField(title: "To", text: $model.to)
        if model.showCcBcc {
          MailRecipientField(title: "Cc", text: $model.cc)
          MailRecipientField(title: "Bcc", text: $model.bcc)
        } else {
          Button("Add Cc or Bcc") { model.showCcBcc = true }
            .font(.subheadline)
        }
        TextField("Subject", text: $model.subject)
      }
      Section {
        TextEditor(text: $model.text)
          .frame(minHeight: 220)
          .accessibilityLabel("Message")
      }
      if !data.signatures.isEmpty {
        Section {
          Picker("Signature", selection: $model.signatureId) {
            Text("None").tag(String?.none)
            ForEach(data.signatures) { signature in
              Text(signature.name).tag(String?.some(signature.id))
            }
          }
        }
      }
      attachments(data)
    }
  }

  private func attachments(_ data: ComposeData) -> some View {
    Section {
      ForEach(data.prefill.files) { file in
        HStack(spacing: 8) {
          Image(systemName: "paperclip")
            .foregroundStyle(.secondary)
          Text(file.filename)
            .lineLimit(1)
          Spacer()
          Text(file.size.formatted(.byteCount(style: .file)))
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .font(.subheadline)
      }
      ForEach(model.attachments) { attachment in
        HStack(spacing: 8) {
          Image(systemName: "paperclip")
            .foregroundStyle(Theme.accent)
          Text(attachment.name)
            .lineLimit(1)
          Spacer()
          Text(Int64(attachment.size).formatted(.byteCount(style: .file)))
            .font(.caption)
            .foregroundStyle(.secondary)
          Button {
            model.remove(attachment.id)
          } label: {
            Image(systemName: "xmark.circle.fill")
              .foregroundStyle(.secondary)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Remove \(attachment.name)")
        }
        .font(.subheadline)
      }
      PhotosPicker(selection: $photoItems, matching: .any(of: [.images, .videos])) {
        Label("Add a photo", systemImage: "photo")
      }
      Button {
        importingFiles = true
      } label: {
        Label("Add a file", systemImage: "doc")
      }
    } header: {
      Text("Attachments")
    } footer: {
      if !data.prefill.files.isEmpty {
        Text("The files kept with the draft or the original go with it.")
      }
    }
  }

  // MARK: Actions

  private func send() async {
    guard await model.send(client) else { return }
    dismiss()
    onSent()
  }

  private func close() {
    if model.isDirty {
      askingToClose = true
    } else {
      dismiss()
    }
  }

  private func saveAndClose() async {
    guard await model.saveDraft(client) else { return }
    dismiss()
    onSent()
  }

  private func deleteAndClose() async {
    guard await model.deleteDraft(client) else { return }
    dismiss()
    onSent()
  }

  private func addFiles(_ result: Result<[URL], any Error>) async {
    switch result {
    case .success(let urls):
      for url in urls {
        do {
          model.add(try await MailComposeModel.read(url))
        } catch {
          model.error = failureMessage(error)
        }
      }
    case .failure(let error):
      model.error = failureMessage(error)
    }
  }

  private func addPhotos(_ items: [PhotosPickerItem]) async {
    for (index, item) in items.enumerated() {
      guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
      let type = item.supportedContentTypes.first
      let ext = type?.preferredFilenameExtension ?? "jpg"
      let name = "Photo \(model.attachments.count + index + 1).\(ext)"
      model.add(MailPickedFile(name: name, contentType: type?.preferredMIMEType ?? "image/jpeg", data: data))
    }
    photoItems = []
  }
}
