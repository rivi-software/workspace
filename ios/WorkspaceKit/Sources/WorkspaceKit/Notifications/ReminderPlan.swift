import Foundation

/// What the person chose for the reminders the app schedules on the phone itself.
public struct ReminderSettings: Codable, Hashable, Sendable {
  /// A reminder before each timed event, and on the morning of an all-day one.
  public var events: Bool
  /// How long before a timed event starts; 0 is when it starts.
  public var eventLeadMinutes: Int
  /// A morning reminder of the open tasks due that day.
  public var tasks: Bool
  /// The morning reminders' time: all-day events and the tasks due that day.
  public var morningHour: Int
  public var morningMinute: Int

  public init(
    events: Bool = false, eventLeadMinutes: Int = 10, tasks: Bool = false, morningHour: Int = 8,
    morningMinute: Int = 0
  ) {
    self.events = events
    self.eventLeadMinutes = eventLeadMinutes
    self.tasks = tasks
    self.morningHour = morningHour
    self.morningMinute = morningMinute
  }

  /// The leads the settings offer, in minutes.
  public static let leads = [0, 5, 10, 15, 30, 60]

  /// The lead in words: "10 minutes", "1 hour".
  public static func leadWords(_ minutes: Int) -> String {
    if minutes > 0, minutes % 60 == 0 {
      let hours = minutes / 60
      return hours == 1 ? "1 hour" : "\(hours) hours"
    }
    return minutes == 1 ? "1 minute" : "\(minutes) minutes"
  }
}

/// A local notification to schedule: when, what it says, and where a tap opens the app.
public struct PlannedReminder: Hashable, Sendable, Identifiable {
  /// The request's identifier, under `ReminderPlan.identifierPrefix`.
  public var id: String
  public var fireAt: Date
  public var title: String
  public var subtitle: String
  public var body: String
  /// Groups reminders of a kind in Notification Center.
  public var group: String
  public var route: NotificationRoute
}

/// The reminders for the coming days from the events and tasks the app loaded: one before each
/// timed event the person has not declined, one on the morning of an all-day event's first day,
/// and one each morning that has open tasks due. Nothing in the past; at most `limit`, soonest
/// first, since iOS keeps 64 pending requests an app.
public enum ReminderPlan {
  public static let identifierPrefix = "reminder."
  public static let limit = 60
  /// How far ahead the app plans: it plans again each time it comes to the front.
  public static let horizonDays = 7

  public static func plan(
    events: [EventOccurrence], tasks: [TaskRow], settings: ReminderSettings, now: Date,
    calendar: Calendar
  ) -> [PlannedReminder] {
    guard let horizon = calendar.date(byAdding: .day, value: horizonDays, to: now) else { return [] }
    var planned: [PlannedReminder] = []
    if settings.events {
      planned += events.compactMap { eventReminder($0, settings: settings, calendar: calendar) }
    }
    if settings.tasks {
      planned += taskReminders(tasks, settings: settings, now: now, calendar: calendar)
    }
    return
      planned
      .filter { $0.fireAt > now && $0.fireAt <= horizon }
      .sorted { ($0.fireAt, $0.id) < ($1.fireAt, $1.id) }
      .prefix(limit)
      .map { $0 }
  }

  /// The morning reminders' moment on a day, in the calendar's zone.
  static func morning(of day: DayKey, settings: ReminderSettings, calendar: Calendar) -> Date? {
    guard let midnight = day.date(in: calendar.timeZone) else { return nil }
    return calendar.date(
      bySettingHour: settings.morningHour, minute: settings.morningMinute, second: 0, of: midnight)
  }

  private static func eventReminder(
    _ occurrence: EventOccurrence, settings: ReminderSettings, calendar: Calendar
  ) -> PlannedReminder? {
    let event = occurrence.event
    if event.myStatus == .declined { return nil }
    let title = event.title.isEmpty ? "Untitled event" : event.title
    let id = "\(identifierPrefix)event.\(occurrence.key)"

    if event.allDay {
      // An all-day event's days are UTC midnights, read as dates, never through the zone.
      let day = DayKey(occurrence.start, in: .gmt)
      guard let fireAt = morning(of: day, settings: settings, calendar: calendar) else { return nil }
      return PlannedReminder(
        id: id, fireAt: fireAt, title: title, subtitle: event.location, body: "All day today",
        group: "calendar", route: .event(id: event.id, day: day, start: occurrence.start))
    }

    let lead = max(0, settings.eventLeadMinutes)
    let fireAt = occurrence.start.addingTimeInterval(TimeInterval(-lead * 60))
    var time = Date.FormatStyle(date: .omitted, time: .shortened)
    time.timeZone = calendar.timeZone
    time.locale = calendar.locale ?? .current
    let at = occurrence.start.formatted(time)
    let body = lead == 0 ? "Starting now, at \(at)" : "In \(ReminderSettings.leadWords(lead)), at \(at)"
    return PlannedReminder(
      id: id, fireAt: fireAt, title: title, subtitle: event.location, body: body, group: "calendar",
      route: .event(
        id: event.id, day: DayKey(occurrence.start, in: calendar.timeZone), start: occurrence.start))
  }

  private static func taskReminders(
    _ tasks: [TaskRow], settings: ReminderSettings, now: Date, calendar: Calendar
  ) -> [PlannedReminder] {
    let today = DayKey(now, in: calendar.timeZone)
    let open = tasks.filter { !$0.isDone }
    let byDay = Dictionary(grouping: open.compactMap { task in task.dueOn.map { ($0, task) } }) { $0.0 }

    return byDay.compactMap { day, due in
      guard day >= today, let fireAt = morning(of: day, settings: settings, calendar: calendar)
      else { return nil }
      let titles = due.map(\.1.title).sorted()
      return PlannedReminder(
        id: "\(identifierPrefix)tasks.\(day.value)", fireAt: fireAt,
        title: titles.count == 1 ? "Due today" : "\(titles.count) tasks due today", subtitle: "",
        body: listed(titles), group: "tasks", route: .tasks(day: day))
    }
  }

  /// "Send the invoice, Call Ada and 2 more".
  private static func listed(_ titles: [String]) -> String {
    let shown = titles.prefix(3).joined(separator: ", ")
    let rest = titles.count - 3
    return rest > 0 ? "\(shown) and \(rest) more" : shown
  }
}
