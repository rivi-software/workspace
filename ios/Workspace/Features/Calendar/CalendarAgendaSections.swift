import SwiftUI
import WorkspaceKit

// The list sections under the grid: one day's agenda, or the seven days of a week.

/// The selected day: its events (all-day first) and the tasks due.
struct CalendarDaySections: View {
  let day: DayKey
  let items: PlannerDayItems

  var body: some View {
    Section(PlannerDay.longLabel(day)) {
      if items.isEmpty {
        PlannerQuietRow(text: "Nothing planned")
      }
      ForEach(items.allDay) { occurrence in
        CalendarEventRow(occurrence: occurrence)
      }
      ForEach(items.timed) { occurrence in
        CalendarEventRow(occurrence: occurrence)
      }
    }
    if !items.tasks.isEmpty {
      Section("Tasks due") {
        ForEach(items.tasks) { task in
          CalendarTaskRow(task: task)
        }
      }
    }
  }
}

/// The seven days of the selected week, each with its items or a quiet line.
struct CalendarWeekSections: View {
  let days: [DayKey]
  let items: [DayKey: PlannerDayItems]

  private let today = PlannerDay.today

  var body: some View {
    ForEach(days, id: \.self) { day in
      let dayItems = items[day] ?? .empty
      Section {
        if dayItems.isEmpty {
          PlannerQuietRow(text: "Nothing planned")
        }
        ForEach(dayItems.allDay) { occurrence in
          CalendarEventRow(occurrence: occurrence)
        }
        ForEach(dayItems.timed) { occurrence in
          CalendarEventRow(occurrence: occurrence)
        }
        ForEach(dayItems.tasks) { task in
          CalendarTaskRow(task: task)
        }
      } header: {
        if day == today {
          Text("Today, \(PlannerDay.shortLabel(day))")
            .foregroundStyle(Theme.accent)
        } else {
          Text(PlannerDay.shortLabel(day))
        }
      }
    }
  }
}

/// An event on the agenda: a time column (the start over the end, or "All day"), then the title,
/// the place and the answer asked of the reader. Someone else's event shows whose it is.
struct CalendarEventRow: View {
  let occurrence: EventOccurrence
  @ScaledMetric(relativeTo: .subheadline) private var timeColumn: CGFloat = 52
  @Environment(\.dynamicTypeSize) private var typeSize

  var body: some View {
    NavigationLink(value: occurrence) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        // At the accessibility sizes the time stands over the title, which keeps the width.
        let layout =
          typeSize.isAccessibilitySize
          ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
          : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        layout {
          times
            .frame(width: typeSize.isAccessibilitySize ? nil : timeColumn, alignment: .leading)
          details
        }
        Spacer(minLength: 0)
        if let status = occurrence.event.myStatus {
          CalendarAnswerBadge(status: status)
        }
      }
      .padding(.vertical, 2)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityWords)
  }

  private var details: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(occurrence.event.title)
        .font(.body.weight(.medium))
      if !occurrence.event.location.isEmpty {
        Label(occurrence.event.location, systemImage: "mappin.and.ellipse")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      if !occurrence.event.mine {
        Label(occurrence.event.owner.name, systemImage: "person")
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
  }

  @ViewBuilder private var times: some View {
    if occurrence.event.allDay {
      Text("All day")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Theme.accent)
    } else if typeSize.isAccessibilitySize {
      Text(whenLabel)
        .font(.subheadline.weight(.semibold))
        .monospacedDigit()
    } else {
      VStack(alignment: .leading, spacing: 1) {
        Text(occurrence.start.formatted(date: .omitted, time: .shortened))
          .font(.subheadline.weight(.semibold))
        Text(occurrence.end.formatted(date: .omitted, time: .shortened))
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
      .monospacedDigit()
      .lineLimit(1)
      .minimumScaleFactor(0.8)
    }
  }

  private var whenLabel: String {
    if occurrence.event.allDay { return "All day" }
    return PlannerTime.span(occurrence.start, occurrence.end)
  }

  private var accessibilityWords: String {
    var parts = [whenLabel, occurrence.event.title]
    if !occurrence.event.location.isEmpty { parts.append(occurrence.event.location) }
    if !occurrence.event.mine { parts.append(occurrence.event.owner.name) }
    if let status = occurrence.event.myStatus { parts.append(PlannerAttendee.label(status)) }
    return parts.joined(separator: ", ")
  }
}

/// "Accepted", "Declined" or "Not answered" in a small capsule.
struct CalendarAnswerBadge: View {
  let status: AttendeeStatus

  var body: some View {
    Text(PlannerAttendee.label(status))
      .font(.caption2.weight(.medium))
      .foregroundStyle(PlannerColor.attendee(status))
      .padding(.horizontal, 7)
      .padding(.vertical, 3)
      .background(.quaternary, in: .capsule)
  }
}

/// A task due on the day, with its checkbox marking it done through the calendar's model.
struct CalendarTaskRow: View {
  @Environment(\.workspaceClient) private var client
  @Environment(CalendarModel.self) private var model
  let task: TaskRow

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PlannerCheckbox(done: task.isDone) {
        await model.setTaskDone(client, task: task, done: !task.isDone)
      }
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(task.title)
            .strikethrough(task.isDone)
            .foregroundStyle(task.isDone ? .secondary : .primary)
          PlannerPriorityMark(priority: task.priority)
        }
        if let issue = task.github {
          PlannerIssueChip(issue: issue)
        }
      }
    }
  }
}
