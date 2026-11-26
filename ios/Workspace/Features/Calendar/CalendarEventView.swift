import SwiftUI
import WorkspaceKit

/// One event: when and where, the details, the repeat, who is invited and what they answered.
/// An invitee accepts or declines here; the owner edits or deletes.
struct CalendarEventView: View {
  @Environment(\.workspaceClient) private var client
  @Environment(CalendarModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var event: EventView
  @State private var error: String?
  @State private var busy = false
  @State private var editing = false
  @State private var confirmingDelete = false
  private let start: Date
  private let end: Date

  /// `start` and `end` are the occurrence shown when the event repeats; the event's own otherwise.
  init(event: EventView, start: Date? = nil, end: Date? = nil) {
    _event = State(initialValue: event)
    self.start = start ?? event.startsAt
    self.end = end ?? event.endsAt
  }

  var body: some View {
    List {
      if let error {
        Section {
          ErrorBanner(message: error)
        }
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
      }
      Section {
        VStack(alignment: .leading, spacing: 8) {
          Text(event.title)
            .font(.title2.weight(.semibold))
          Label(whenLabel, systemImage: event.allDay ? "calendar" : "clock")
            .foregroundStyle(.secondary)
          if !event.location.isEmpty {
            Label(event.location, systemImage: "mappin.and.ellipse")
              .foregroundStyle(.secondary)
          }
          if let repeatLabel {
            Label(repeatLabel, systemImage: "repeat")
              .foregroundStyle(.secondary)
          }
        }
        .font(.subheadline)
        .padding(.vertical, 4)
      }
      if !event.description.isEmpty {
        Section("Details") {
          Text(event.description)
        }
      }
      if let myStatus = event.myStatus {
        Section("Your answer") {
          answerRow(myStatus)
        }
      }
      Section("People") {
        HStack(spacing: 10) {
          AvatarView(name: event.owner.name, size: 28)
          Text(event.owner.name)
          Spacer()
          Text("Organizer")
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        ForEach(event.attendees) { attendee in
          HStack(spacing: 10) {
            AvatarView(name: attendee.name, size: 28)
            Text(attendee.name)
            Spacer()
            CalendarAnswerBadge(status: attendee.status)
          }
        }
      }
      if event.mine {
        Section {
          Button("Delete event", role: .destructive) { confirmingDelete = true }
            .frame(maxWidth: .infinity)
            .disabled(busy)
        }
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Event")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      if event.mine {
        ToolbarItem(placement: .primaryAction) {
          Button("Edit") { editing = true }
        }
      }
    }
    .sheet(isPresented: $editing) {
      CalendarEventEditor(event: event, onSaved: { event = $0 }, onDeleted: { dismiss() })
    }
    .confirmationDialog(
      "Delete this event?", isPresented: $confirmingDelete, titleVisibility: .visible
    ) {
      Button("Delete event", role: .destructive) {
        Task { await delete() }
      }
    } message: {
      Text("It goes for everyone invited.")
    }
  }

  private func answerRow(_ status: AttendeeStatus) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(currentAnswer(status))
        .font(.subheadline)
        .foregroundStyle(.secondary)
      HStack(spacing: 12) {
        Button("Accept") {
          Task { await respond(.accepted) }
        }
        .prominentAction()
        .disabled(busy || status == .accepted)
        Button("Decline") {
          Task { await respond(.declined) }
        }
        .buttonStyle(.bordered)
        .disabled(busy || status == .declined)
      }
    }
    .padding(.vertical, 4)
  }

  private func currentAnswer(_ status: AttendeeStatus) -> String {
    switch status {
    case .accepted: "You accepted."
    case .declined: "You declined."
    case .needsAction: "\(event.owner.name) invited you."
    case .other(let raw): "Your answer: \(raw)."
    }
  }

  private var whenLabel: String {
    if event.allDay { return "All day, \(PlannerTime.allDaySpan(start, end))" }
    let startDay = DayKey(start)
    let endDay = DayKey(end > start ? end.addingTimeInterval(-1) : end)
    if startDay == endDay {
      return "\(PlannerDay.longLabel(startDay)), \(PlannerTime.span(start, end))"
    }
    return PlannerTime.span(start, end)
  }

  private var repeatLabel: String? {
    let every: String
    switch event.repeat {
    case .none: return nil
    case .daily: every = "Every day"
    case .weekly: every = "Every week"
    case .monthly: every = "Every month"
    case .yearly: every = "Every year"
    case .other(let raw): every = "Repeats \(raw)"
    }
    guard let until = event.repeatUntil else { return every }
    return "\(every) until \(until.formatted(date: .abbreviated, time: .omitted))"
  }

  private func respond(_ status: AttendeeStatus) async {
    busy = true
    error = nil
    do {
      event = try await model.respond(client, eventId: event.id, status: status)
    } catch {
      self.error = failureMessage(error)
    }
    busy = false
  }

  private func delete() async {
    busy = true
    error = nil
    do {
      try await model.deleteEvent(client, id: event.id)
      dismiss()
    } catch {
      self.error = failureMessage(error)
    }
    busy = false
  }
}
