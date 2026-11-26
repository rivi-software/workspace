import SwiftUI
import WorkspaceKit

/// The labels on a conversation or a selection, each a toggle, and a new label to add.
struct MailLabelPicker: View {
  let threadIds: [String]
  /// The shared group inbox the conversations are in, whose labels they take; nil for the
  /// person's own mailbox.
  let box: String?
  /// Called on close once a label changed: the caller reloads.
  let onChange: () -> Void

  @Environment(AppModel.self) private var app
  @Environment(\.workspaceClient) private var client
  @Environment(\.dismiss) private var dismiss
  @State private var applied: Set<String>
  @State private var busy: Set<String> = []
  @State private var newName = ""
  @State private var newColor: LabelColor = .gray
  @State private var creating = false
  @State private var error: String?
  @State private var changed = false

  init(threadIds: [String], applied: Set<String>, box: String? = nil, onChange: @escaping () -> Void) {
    self.threadIds = threadIds
    self.box = box
    self.onChange = onChange
    _applied = State(initialValue: applied)
  }

  var body: some View {
    NavigationStack {
      List {
        if let error {
          ErrorBanner(message: error)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
        Section("Labels") {
          let labels = app.mailLabels
          if labels.isEmpty {
            Text("No labels yet.")
              .foregroundStyle(.secondary)
          }
          ForEach(labels) { label in
            Toggle(isOn: binding(for: label)) {
              Label {
                Text(label.name)
              } icon: {
                Circle()
                  .fill(Theme.label(label.color))
                  .frame(width: 12, height: 12)
              }
            }
            .disabled(busy.contains(label.id))
          }
        }
        Section("New label") {
          TextField("Name", text: $newName)
          HStack(spacing: 10) {
            ForEach(LabelColor.palette, id: \.self) { color in
              Button {
                newColor = color
              } label: {
                Circle()
                  .fill(Theme.label(color))
                  .frame(width: 26, height: 26)
                  .overlay {
                    if color == newColor {
                      Image(systemName: "checkmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white)
                    }
                  }
              }
              .buttonStyle(.plain)
              .accessibilityLabel(color.title)
              .accessibilityAddTraits(color == newColor ? .isSelected : [])
            }
          }
          Button {
            Task { await create() }
          } label: {
            if creating {
              ProgressView()
            } else {
              Text("Add label")
            }
          }
          .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || creating)
        }
      }
      .navigationTitle("Labels")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .onDisappear {
      if changed { onChange() }
    }
  }

  private func binding(for label: LabelRef) -> Binding<Bool> {
    Binding(
      get: { applied.contains(label.id) },
      set: { on in Task { await toggle(label, on: on) } })
  }

  private func toggle(_ label: LabelRef, on: Bool) async {
    guard !busy.contains(label.id) else { return }
    busy.insert(label.id)
    defer { busy.remove(label.id) }
    error = nil
    do {
      _ = try await client.act(
        ThreadAction(ids: threadIds, intent: on ? .label : .unlabel, labelId: label.id), box: box)
      if on {
        applied.insert(label.id)
      } else {
        applied.remove(label.id)
      }
      changed = true
    } catch {
      self.error = failureMessage(error)
    }
  }

  /// Makes the label, refreshes the person's list of them and puts it on the conversations.
  private func create() async {
    let name = newName.trimmingCharacters(in: .whitespaces)
    guard !name.isEmpty else { return }
    creating = true
    defer { creating = false }
    error = nil
    do {
      let label = try await client.createLabel(NewLabel(name: name, color: newColor), box: box)
      newName = ""
      await app.reloadMe()
      await toggle(label, on: true)
    } catch {
      self.error = failureMessage(error)
    }
  }
}
