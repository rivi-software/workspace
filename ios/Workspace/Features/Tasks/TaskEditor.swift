import SwiftUI
import WorkspaceKit

/// The sheet that makes or changes a task: title, notes, a due day, the priority, and what it
/// is linked to. The due day is sent as a `DayKey` in the reader's zone.
struct TaskEditor: View {
  @Environment(\.workspaceClient) private var client
  @Environment(\.dismiss) private var dismiss

  private let existing: TaskRow?
  private let onChanged: () async -> Void

  @State private var title: String
  @State private var notes: String
  @State private var hasDue: Bool
  @State private var due: Date
  @State private var priority: TaskPriority
  @State private var error: String?
  @State private var saving = false
  @State private var confirmingDelete = false

  /// `task` nil makes a new one; `onChanged` runs after a save or a deletion.
  init(task: TaskRow?, onChanged: @escaping () async -> Void = {}) {
    existing = task
    self.onChanged = onChanged
    _title = State(initialValue: task?.title ?? "")
    _notes = State(initialValue: task?.notes ?? "")
    _hasDue = State(initialValue: task?.dueOn != nil)
    _due = State(initialValue: task?.dueOn?.date() ?? Date())
    _priority = State(initialValue: Self.knownPriority(task?.priority ?? .normal))
  }

  var body: some View {
    NavigationStack {
      Form {
        if let error {
          Section {
            ErrorBanner(message: error)
          }
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
        }
        Section {
          TextField("Title", text: $title)
        }
        Section("Notes") {
          TextEditor(text: $notes)
            .frame(minHeight: 96)
        }
        Section {
          Toggle("Has a due day", isOn: $hasDue)
          if hasDue {
            DatePicker("Due", selection: $due, displayedComponents: [.date])
          }
        }
        Section("Priority") {
          Picker("Priority", selection: $priority) {
            Text("Low").tag(TaskPriority.low)
            Text("Normal").tag(TaskPriority.normal)
            Text("High").tag(TaskPriority.high)
          }
          .pickerStyle(.segmented)
        }
        linksSection
        if existing != nil {
          Section {
            Button("Delete task", role: .destructive) { confirmingDelete = true }
              .frame(maxWidth: .infinity)
              .disabled(saving)
          }
        }
      }
      .navigationTitle(existing == nil ? "New task" : "Edit task")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
            .disabled(saving)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Save") {
            Task { await save() }
          }
          .prominentAction()
          .disabled(saving || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
      .confirmationDialog(
        "Delete this task?", isPresented: $confirmingDelete, titleVisibility: .visible
      ) {
        Button("Delete task", role: .destructive) {
          Task { await delete() }
        }
      }
    }
    .interactiveDismissDisabled(saving)
  }

  /// The GitHub issue the task was made from, read-only, with a link out. Marking the task done
  /// closes the issue.
  @ViewBuilder private var linksSection: some View {
    if let issue = existing?.github {
      Section {
        if let url = URL(string: issue.url) {
          Link(destination: url) {
            linkRow(
              title: "\(issue.repo)#\(issue.number)",
              subtitle: issue.state == .closed ? "Closed on GitHub" : "Opens on GitHub")
          }
        }
      } header: {
        Text("GitHub")
      } footer: {
        Text("Marking the task done closes the issue, and reopening it reopens the issue.")
      }
    }
  }

  private func linkRow(title: String, subtitle: String) -> some View {
    HStack {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .foregroundStyle(.primary)
          .lineLimit(2)
        Text(subtitle)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      Spacer()
      Image(systemName: "arrow.up.right")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }

  /// The segmented picker knows three priorities; another word from the server shows as normal.
  private static func knownPriority(_ priority: TaskPriority) -> TaskPriority {
    switch priority {
    case .low, .normal, .high: priority
    case .other: .normal
    }
  }

  private func makeInput() -> TaskInput {
    let dueOn: DueDay
    if hasDue {
      dueOn = .on(DayKey(due))
    } else {
      dueOn = existing?.dueOn == nil ? .unchanged : .cleared
    }
    return TaskInput(
      title: title.trimmingCharacters(in: .whitespacesAndNewlines), notes: notes, dueOn: dueOn,
      priority: priority)
  }

  private func save() async {
    saving = true
    error = nil
    do {
      let input = makeInput()
      if let existing {
        _ = try await client.updateTask(id: existing.id, input)
      } else {
        _ = try await client.createTask(input)
      }
      await onChanged()
      dismiss()
    } catch {
      self.error = failureMessage(error)
    }
    saving = false
  }

  private func delete() async {
    guard let existing else { return }
    saving = true
    error = nil
    do {
      _ = try await client.deleteTask(id: existing.id)
      await onChanged()
      dismiss()
    } catch {
      self.error = failureMessage(error)
    }
    saving = false
  }
}
