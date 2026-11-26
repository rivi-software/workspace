import SwiftUI
import WorkspaceKit

/// A task in the list: the checkbox, the title with its priority, the notes, the due label and
/// the chips of what it is linked to. The checkbox is its own button; the rest opens the editor.
struct TaskRowView: View {
  let task: TaskRow
  let onToggle: () async -> Void
  let onTap: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PlannerCheckbox(done: task.isDone, action: onToggle)
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(task.title)
            .strikethrough(task.isDone)
            .foregroundStyle(task.isDone ? .secondary : .primary)
          PlannerPriorityMark(priority: task.priority)
        }
        if !task.notes.isEmpty {
          Text(task.notes)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        if task.dueOn != nil || task.completedAt != nil || task.github != nil {
          HStack(spacing: 8) {
            if task.isDone, let completedAt = task.completedAt {
              Text("Completed \(completedAt.formatted(date: .abbreviated, time: .omitted))")
                .foregroundStyle(.secondary)
            } else if let due = task.dueOn {
              Text(PlannerDay.dueLabel(due))
                .foregroundStyle(due < PlannerDay.today ? Theme.red : Theme.muted)
            }
            if let issue = task.github {
              PlannerIssueChip(issue: issue)
            }
          }
          .font(.caption)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .onTapGesture(perform: onTap)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isButton)
      .accessibilityHint("Opens the task")
    }
  }
}

/// The open GitHub issues assigned to the person, each with a way to add it as a task. Nothing
/// while GitHub is not connected (Settings → Tasks in the console); a line saying so while it does
/// not answer, so an empty list never reads as "none".
struct TasksIssuesSection: View {
  let github: TasksGitHub
  let linked: Set<String>
  @Binding var showAll: Bool
  let onAdd: (GitHubIssue) -> Void

  var body: some View {
    if github.connected {
      Section("Your GitHub issues") {
        if let issues = github.issues {
          if issues.isEmpty {
            PlannerQuietRow(text: "No open issues assigned to you")
          }
          ForEach(showAll ? issues : Array(issues.prefix(TasksModel.collapsedCount))) { issue in
            TaskIssueRow(issue: issue, added: linked.contains(issue.id)) { onAdd(issue) }
          }
          if issues.count > TasksModel.collapsedCount {
            Button(showAll ? "Show fewer" : "Show all \(issues.count)") { showAll.toggle() }
              .font(.subheadline)
          }
        } else {
          PlannerQuietRow(text: "GitHub did not answer. Pull to try again.")
        }
      }
    }
  }
}

/// An issue: its repository and number, its title and labels, and "Add as task" or the check
/// once added.
struct TaskIssueRow: View {
  @Environment(\.openURL) private var openURL
  let issue: GitHubIssue
  let added: Bool
  let onAdd: () -> Void

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text("\(issue.repo)#\(issue.number)")
          .font(.caption)
          .foregroundStyle(.secondary)
          .monospacedDigit()
        Text(issue.title)
          .lineLimit(2)
        if !issue.labels.isEmpty {
          Text(issue.labels.joined(separator: " · "))
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .onTapGesture {
        if let url = URL(string: issue.url) { openURL(url) }
      }
      .accessibilityHint("Opens the issue on GitHub")
      TaskAddButton(added: added, action: onAdd)
    }
  }
}

/// "Add as task", or a check once it is one.
private struct TaskAddButton: View {
  let added: Bool
  let action: () -> Void

  var body: some View {
    if added {
      Label("Added", systemImage: "checkmark")
        .font(.caption.weight(.medium))
        .foregroundStyle(Theme.accent)
        .labelStyle(.titleAndIcon)
    } else {
      Button("Add as task", action: action)
        .font(.caption.weight(.semibold))
        .buttonStyle(.bordered)
        .buttonBorderShape(.capsule)
    }
  }
}
