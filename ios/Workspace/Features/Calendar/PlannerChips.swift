import SwiftUI
import WorkspaceKit

// Small pieces Calendar and Tasks share: colors by state, the checkbox, the chips, the toast.

/// The colors both planners read.
enum PlannerColor {
  static func priority(_ priority: TaskPriority) -> Color {
    switch priority {
    case .high: Theme.red
    case .low: Theme.muted
    case .normal, .other: Theme.foreground
    }
  }

  static func attendee(_ status: AttendeeStatus) -> Color {
    switch status {
    case .accepted: Theme.label(.green)
    case .declined: Theme.red
    case .needsAction, .other: Theme.muted
    }
  }
}

/// An attendee's answer in words.
enum PlannerAttendee {
  static func label(_ status: AttendeeStatus) -> String {
    switch status {
    case .accepted: "Accepted"
    case .declined: "Declined"
    case .needsAction: "Not answered"
    case .other(let raw): raw.capitalized
    }
  }
}

/// "High" in red or "Low" in the muted color beside a task; nothing for normal.
struct PlannerPriorityMark: View {
  let priority: TaskPriority

  var body: some View {
    switch priority {
    case .high: mark("High")
    case .low: mark("Low")
    case .normal, .other: EmptyView()
    }
  }

  private func mark(_ text: String) -> some View {
    Text(text)
      .font(.caption.weight(.semibold))
      .foregroundStyle(PlannerColor.priority(priority))
  }
}

/// A round checkbox: an empty circle, a filled check once done. It answers the tap at once (the
/// check fills, with a tap felt) while `action` tells the server, and settles on what the data
/// says once that returns. Its target is 44 points though it draws 28.
struct PlannerCheckbox: View {
  let done: Bool
  let action: () async -> Void
  /// What the tap asked for while the server is being told.
  @State private var pending: Bool?

  var body: some View {
    let shown = pending ?? done
    Button {
      guard pending == nil else { return }
      pending = !done
      Task {
        await action()
        pending = nil
      }
    } label: {
      Image(systemName: shown ? "checkmark.circle.fill" : "circle")
        .font(.title3)
        .foregroundStyle(shown ? Theme.accent : Theme.faint)
        .contentTransition(.symbolEffect(.replace))
        .frame(width: 28, height: 28)
        .contentShape(.rect.inset(by: -8))
    }
    .buttonStyle(.borderless)
    .sensoryFeedback(trigger: pending) { _, new in
      new == true ? .success : nil
    }
    .accessibilityLabel(shown ? "Mark as open" : "Mark as done")
  }
}

/// A small capsule with a symbol and a short text: a link, a label.
struct PlannerChip: View {
  let text: String
  var systemImage: String?
  var color: Color = Theme.muted

  var body: some View {
    HStack(spacing: 3) {
      if let systemImage {
        Image(systemName: systemImage)
      }
      Text(text)
        .lineLimit(1)
    }
    .font(.caption2.weight(.medium))
    .foregroundStyle(color)
    .padding(.horizontal, 7)
    .padding(.vertical, 3)
    .background(.quaternary, in: .capsule)
  }
}

/// "repo#123" for a task made from a GitHub issue, struck through once the issue is closed.
struct PlannerIssueChip: View {
  let issue: TaskIssue

  private var name: String {
    let repo = issue.repo.split(separator: "/").last.map(String.init) ?? issue.repo
    return "\(repo)#\(issue.number)"
  }

  var body: some View {
    PlannerChip(text: name, systemImage: issue.state == .closed ? "checkmark.circle" : "circle.circle")
      .accessibilityLabel(
        "GitHub issue \(issue.repo) number \(issue.number)\(issue.state == .closed ? ", closed" : "")")
  }
}

/// A quiet row for a day or a section with nothing in it.
struct PlannerQuietRow: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.subheadline)
      .foregroundStyle(.secondary)
  }
}

/// A short confirmation floating over the list for a moment.
struct PlannerToast: View {
  let text: String

  var body: some View {
    GlassPillLabel(text: text, systemImage: "checkmark")
      .accessibilityAddTraits(.updatesFrequently)
  }
}
