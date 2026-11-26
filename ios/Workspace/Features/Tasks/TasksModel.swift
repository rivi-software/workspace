import Foundation
import Observation
import WorkspaceKit

/// Tasks' state: the open and done views, the open tasks in their groups, and what the last
/// change said. Every change reloads the shown view; the other is read again when it is shown.
@Observable @MainActor
final class TasksModel {
  /// The open list's groups, in order.
  enum Bucket: Hashable, CaseIterable {
    case overdue, today, upcoming, noDate

    var title: String {
      switch self {
      case .overdue: "Overdue"
      case .today: "Today"
      case .upcoming: "Upcoming"
      case .noDate: "No date"
      }
    }
  }

  struct Grouped: Identifiable, Hashable {
    let bucket: Bucket
    var tasks: [TaskRow]

    var id: Bucket { bucket }
  }

  /// A long section shows this many rows until "Show all".
  static let collapsedCount = 8

  var view: TaskStatus = .open
  var open: LoadState<TasksData> = .idle
  var done: LoadState<TasksData> = .idle
  /// What the last change said went wrong.
  var actionError: String?
  /// A short confirmation, shown for a moment.
  private(set) var toast: String?
  var showAllIssues = false

  @ObservationIgnored private var toastTask: Task<Void, Never>?

  var current: LoadState<TasksData> { view == .done ? done : open }

  /// Open tasks in their groups; a group without tasks is left out.
  var sections: [Grouped] {
    guard let data = open.value else { return [] }
    return Self.group(data.tasks)
  }

  /// Done tasks, the last completed first.
  var doneTasks: [TaskRow] {
    (done.value?.tasks ?? []).sorted {
      ($0.completedAt ?? .distantPast) > ($1.completedAt ?? .distantPast)
    }
  }

  /// The issues (`owner/name#123`) every open task was made from.
  var linkedIssues: Set<String> {
    Set((open.value?.tasks ?? []).compactMap { $0.github.map { "\($0.repo)#\($0.number)" } })
  }

  /// Overdue, today, upcoming, no date; within a group by due day, priority, then creation.
  static func group(_ tasks: [TaskRow], today: DayKey = PlannerDay.today) -> [Grouped] {
    var buckets: [Bucket: [TaskRow]] = [:]
    for task in tasks {
      let bucket: Bucket
      if let due = task.dueOn {
        bucket = due < today ? .overdue : (due == today ? .today : .upcoming)
      } else {
        bucket = .noDate
      }
      buckets[bucket, default: []].append(task)
    }
    return Bucket.allCases.compactMap { bucket in
      guard let rows = buckets[bucket], !rows.isEmpty else { return nil }
      return Grouped(bucket: bucket, tasks: rows.sorted(by: PlannerPriority.before))
    }
  }

  // MARK: Loading

  /// Loads the shown view.
  func load(_ client: WorkspaceClient) async {
    if view == .done {
      done.begin()
      do {
        done.finish(try await client.tasks(view: .done))
      } catch {
        done.fail(error)
      }
    } else {
      open.begin()
      do {
        open.finish(try await client.tasks(view: .open))
      } catch {
        open.fail(error)
      }
    }
  }

  /// After a change: the shown view reloads and the other is forgotten until it is shown.
  func reloadAfterChange(_ client: WorkspaceClient) async {
    if view == .done {
      open = .idle
    } else {
      done = .idle
    }
    await load(client)
  }

  // MARK: Changes

  /// Marks a task done or open; the server's words land in `actionError`.
  func setDone(_ client: WorkspaceClient, task: TaskRow, done: Bool) async {
    actionError = nil
    do {
      _ = try await client.setTaskDone(id: task.id, done: done)
      await reloadAfterChange(client)
    } catch {
      actionError = failureMessage(error)
    }
  }

  func delete(_ client: WorkspaceClient, task: TaskRow) async {
    actionError = nil
    do {
      _ = try await client.deleteTask(id: task.id)
      await reloadAfterChange(client)
    } catch {
      actionError = failureMessage(error)
    }
  }

  /// Adds a GitHub issue as a task; done there closes the issue.
  func addIssue(_ client: WorkspaceClient, _ issue: GitHubIssue) async {
    actionError = nil
    do {
      let result = try await client.taskFromIssue(issue)
      show(toast: result.existed ? "Already a task" : "Added as a task")
      await reloadAfterChange(client)
    } catch {
      actionError = failureMessage(error)
    }
  }

  private func show(toast text: String) {
    toast = text
    toastTask?.cancel()
    toastTask = Task {
      try? await Task.sleep(for: .seconds(2.5))
      guard !Task.isCancelled else { return }
      toast = nil
    }
  }
}
