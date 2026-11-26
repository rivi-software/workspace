import SwiftUI
import WorkspaceKit

/// The sheet that makes or changes an event. An all-day event is sent as the UTC midnights of
/// its first day and the day after its last; a timed one as its moments in the reader's zone.
/// Opened from Calendar it reloads Calendar's model after a change; opened from the create
/// menu, over another tab, there is none, and `onSaved` tells Calendar instead.
struct CalendarEventEditor: View {
  @Environment(\.workspaceClient) private var client
  @Environment(CalendarModel.self) private var model: CalendarModel?
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss

  private let existing: EventView?
  private let onSaved: ((EventView) -> Void)?
  private let onDeleted: (() -> Void)?

  @State private var title: String
  @State private var location: String
  @State private var details: String
  @State private var allDay: Bool
  @State private var start: Date
  @State private var end: Date
  @State private var repeats: EventRepeat
  @State private var hasRepeatUntil: Bool
  @State private var repeatUntil: Date
  @State private var invitees: Set<String>
  @State private var search = ""
  @State private var error: String?
  @State private var saving = false
  @State private var confirmingDelete = false

  private static let hour: TimeInterval = 3600
  private static let searchThreshold = 10

  /// `event` nil makes a new one on `day` at the next full hour, for an hour.
  init(
    event: EventView?, day: DayKey? = nil, onSaved: ((EventView) -> Void)? = nil,
    onDeleted: (() -> Void)? = nil
  ) {
    existing = event
    self.onSaved = onSaved
    self.onDeleted = onDeleted
    let (initialStart, initialEnd) = Self.initialSpan(event, day: day ?? PlannerDay.today)
    _title = State(initialValue: event?.title ?? "")
    _location = State(initialValue: event?.location ?? "")
    _details = State(initialValue: event?.description ?? "")
    _allDay = State(initialValue: event?.allDay ?? false)
    _start = State(initialValue: initialStart)
    _end = State(initialValue: initialEnd)
    _repeats = State(initialValue: event?.repeat ?? .none)
    _hasRepeatUntil = State(initialValue: event?.repeatUntil != nil)
    _repeatUntil = State(initialValue: event?.repeatUntil ?? initialEnd)
    _invitees = State(initialValue: Set(event?.attendees.map(\.id) ?? []))
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
          TextField("Location", text: $location)
        }
        Section {
          Toggle("All day", isOn: $allDay)
          DatePicker("Starts", selection: $start, displayedComponents: dateComponents)
          DatePicker("Ends", selection: $end, in: start..., displayedComponents: dateComponents)
        }
        Section("Repeat") {
          Picker("Repeat", selection: $repeats) {
            Text("Never").tag(EventRepeat.none)
            Text("Every day").tag(EventRepeat.daily)
            Text("Every week").tag(EventRepeat.weekly)
            Text("Every month").tag(EventRepeat.monthly)
            Text("Every year").tag(EventRepeat.yearly)
          }
          if repeats != .none {
            Toggle("Until a day", isOn: $hasRepeatUntil)
            if hasRepeatUntil {
              DatePicker("Until", selection: $repeatUntil, in: start..., displayedComponents: [.date])
            }
          }
        }
        Section("Details") {
          TextEditor(text: $details)
            .frame(minHeight: 96)
        }
        inviteesSection
        if existing != nil {
          Section {
            Button("Delete event", role: .destructive) { confirmingDelete = true }
              .frame(maxWidth: .infinity)
              .disabled(saving)
          }
        }
      }
      .navigationTitle(existing == nil ? "New event" : "Edit event")
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
      .onChange(of: start) { previous, current in
        let duration = max(end.timeIntervalSince(previous), allDay ? 0 : Self.hour)
        if end <= current {
          end = current.addingTimeInterval(duration)
        }
      }
      .onChange(of: allDay) { _, isAllDay in
        if !isAllDay, end <= start {
          end = start.addingTimeInterval(Self.hour)
        }
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
    .interactiveDismissDisabled(saving)
  }

  private var dateComponents: DatePickerComponents {
    allDay ? [.date] : [.date, .hourAndMinute]
  }

  // MARK: Invitees

  private var colleagues: [Colleague] { app.me?.colleagues ?? [] }

  private var shownColleagues: [Colleague] {
    let term = search.trimmingCharacters(in: .whitespaces)
    guard !term.isEmpty else { return colleagues }
    return colleagues.filter { $0.name.localizedCaseInsensitiveContains(term) }
  }

  @ViewBuilder private var inviteesSection: some View {
    Section {
      if colleagues.isEmpty {
        PlannerQuietRow(text: "No colleagues in the workspace yet")
      }
      if colleagues.count > Self.searchThreshold {
        TextField("Search by name", text: $search)
          .textInputAutocapitalization(.never)
      }
      ForEach(shownColleagues) { colleague in
        inviteeRow(colleague)
      }
    } header: {
      Text(invitees.isEmpty ? "Invitees" : "Invitees (\(invitees.count))")
    }
  }

  private func inviteeRow(_ colleague: Colleague) -> some View {
    let selected = invitees.contains(colleague.id)
    return Button {
      if selected {
        invitees.remove(colleague.id)
      } else {
        invitees.insert(colleague.id)
      }
    } label: {
      HStack(spacing: 10) {
        AvatarView(name: colleague.name, size: 28)
        VStack(alignment: .leading, spacing: 1) {
          Text(colleague.name)
            .foregroundStyle(.primary)
          Text(colleague.email)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        Spacer()
        if selected {
          Image(systemName: "checkmark")
            .foregroundStyle(Theme.accent)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  // MARK: Saving

  private static func initialSpan(_ event: EventView?, day: DayKey) -> (Date, Date) {
    guard let event else {
      let calendar = Calendar.current
      let now = Date()
      let nextHour = min(calendar.component(.hour, from: now) + 1, 23)
      let dayStart = day.date() ?? now
      let start = calendar.date(bySettingHour: nextHour, minute: 0, second: 0, of: dayStart) ?? dayStart
      return (start, start.addingTimeInterval(hour))
    }
    guard event.allDay else { return (event.startsAt, event.endsAt) }
    let first = DayKey(event.startsAt, in: .gmt)
    let afterLast = DayKey(event.endsAt, in: .gmt)
    let last = afterLast > first ? PlannerDay.adding(-1, to: afterLast) : first
    return (first.date() ?? event.startsAt, last.date() ?? event.endsAt)
  }

  private func makeInput() -> EventInput? {
    let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedTitle.isEmpty else {
      error = "Give the event a title."
      return nil
    }
    let startsAt: Date
    let endsAt: Date
    if allDay {
      let firstDay = DayKey(start)
      let lastDay = max(firstDay, DayKey(end))
      guard let first = firstDay.date(in: .gmt),
        let afterLast = PlannerDay.adding(1, to: lastDay).date(in: .gmt)
      else {
        error = "Those days could not be read."
        return nil
      }
      startsAt = first
      endsAt = afterLast
    } else {
      guard end > start else {
        error = "The end must come after the start."
        return nil
      }
      startsAt = start
      endsAt = end
    }
    let until = repeats != .none && hasRepeatUntil ? PlannerDay.end(of: DayKey(repeatUntil)) : nil
    return EventInput(
      title: trimmedTitle, description: details, location: location, startsAt: startsAt,
      endsAt: endsAt, allDay: allDay, timeZone: TimeZone.current.identifier, repeat: repeats,
      repeatUntil: until, attendees: invitees.sorted())
  }

  private func save() async {
    guard let input = makeInput() else { return }
    saving = true
    error = nil
    do {
      let saved: EventView
      if let existing {
        saved = try await client.updateEvent(id: existing.id, input)
      } else {
        saved = try await client.createEvent(input)
      }
      await model?.reloadAfterChange(client)
      onSaved?(saved)
      dismiss()
    } catch {
      self.error = failureMessage(error)
    }
    saving = false
  }

  private func delete() async {
    // Only an event opened from Calendar can be deleted, so its model is there.
    guard let existing, let model else { return }
    saving = true
    error = nil
    do {
      try await model.deleteEvent(client, id: existing.id)
      onDeleted?()
      dismiss()
    } catch {
      self.error = failureMessage(error)
    }
    saving = false
  }
}
