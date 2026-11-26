import SwiftUI
import WorkspaceKit

/// Tasks: the open list in its groups with the GitHub issues assigned to the person under it, or the done list; a row
/// opens its editor, and a new task starts from the create menu (`tabToolbar`).
struct TasksRootView: View {
  @Environment(\.workspaceClient) private var client
  @State private var model = TasksModel()
  /// The task whose editor is open.
  @State private var editing: TaskRow?
  @State private var pendingDelete: TaskRow?

  var body: some View {
    List {
      Section {
        Picker("View", selection: $model.view) {
          Text("Open").tag(TaskStatus.open)
          Text("Done").tag(TaskStatus.done)
        }
        .pickerStyle(.segmented)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
      }
      if let error = model.actionError {
        Section {
          ErrorBanner(message: error)
        }
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
      }
      loadStatus
      switch model.view {
      case .done:
        doneSections
      case .open, .other:
        openSections
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Tasks")
    .tabToolbar()
    .overlay(alignment: .bottom) {
      if let toast = model.toast {
        PlannerToast(text: toast)
          .padding(.bottom, 24)
          .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.default, value: model.toast)
    .sheet(item: $editing) { task in
      TaskEditor(task: task) { await model.reloadAfterChange(client) }
    }
    .confirmationDialog(
      "Delete this task?", isPresented: deletingBinding, titleVisibility: .visible,
      presenting: pendingDelete
    ) { task in
      Button("Delete task", role: .destructive) {
        Task { await model.delete(client, task: task) }
      }
    } message: { task in
      Text(task.title)
    }
    .task(id: model.view) {
      guard model.current.value == nil else { return }
      await model.load(client)
    }
    .refreshable { await model.load(client) }
    .reloadsWhileOpen { await model.load(client) }
    // A task made from the create menu.
    .onChange(of: ChangeSignal.planner.version) { Task { await model.reloadAfterChange(client) } }
  }

  private var deletingBinding: Binding<Bool> {
    Binding(
      get: { pendingDelete != nil },
      set: { shown in
        if !shown { pendingDelete = nil }
      })
  }

  @ViewBuilder private var loadStatus: some View {
    switch model.current {
    case .idle, .loading:
      LoadingSection()
    case .failed(let message, _):
      Section {
        ErrorBanner(message: message) { await model.load(client) }
      }
      .listRowInsets(EdgeInsets())
      .listRowBackground(Color.clear)
    case .loaded:
      EmptyView()
    }
  }

  // MARK: Open

  @ViewBuilder private var openSections: some View {
    if let data = model.open.value {
      if data.tasks.isEmpty {
        Section {
          PlannerQuietRow(text: "No open tasks. Everything is done.")
        }
      }
      ForEach(model.sections) { group in
        Section {
          ForEach(group.tasks) { task in
            taskRow(task, done: true)
          }
        } header: {
          TasksBucketHeader(bucket: group.bucket, count: group.tasks.count)
        }
      }
      TasksIssuesSection(
        github: data.github, linked: model.linkedIssues, showAll: $model.showAllIssues
      ) { issue in
        Task { await model.addIssue(client, issue) }
      }
    }
  }

  // MARK: Done

  @ViewBuilder private var doneSections: some View {
    if model.done.value != nil {
      Section {
        if model.doneTasks.isEmpty {
          PlannerQuietRow(text: "Nothing done yet")
        }
        ForEach(model.doneTasks) { task in
          taskRow(task, done: false)
        }
      }
    }
  }

  /// A row whose checkbox marks the task `done`, with a swipe to delete it.
  private func taskRow(_ task: TaskRow, done: Bool) -> some View {
    TaskRowView(
      task: task,
      onToggle: { await model.setDone(client, task: task, done: done) },
      onTap: { editing = task }
    )
    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
      Button("Delete", systemImage: "trash", role: .destructive) {
        pendingDelete = task
      }
    }
  }
}

/// A group's name and how many it holds; Overdue in red, Today in the accent.
private struct TasksBucketHeader: View {
  let bucket: TasksModel.Bucket
  let count: Int

  var body: some View {
    HStack(spacing: 6) {
      Text(bucket.title)
        .foregroundStyle(color)
      Text("\(count)")
        .foregroundStyle(.tertiary)
        .monospacedDigit()
    }
    .accessibilityElement(children: .combine)
  }

  private var color: Color {
    switch bucket {
    case .overdue: Theme.red
    case .today: Theme.accent
    case .upcoming, .noDate: .secondary
    }
  }
}
