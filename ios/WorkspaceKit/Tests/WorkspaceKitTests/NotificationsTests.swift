import Foundation
import Testing

@testable import WorkspaceKit

struct NotificationRouteTests {
  @Test func readsTheNewMailPushTheWorkerSends() {
    // The keys beside `aps` a push of new mail carries (the monorepo's Worker sends it; this one
    // sends none yet, and the route stays for the day it does).
    let info: [AnyHashable: Any] = ["kind": "mail", "threadId": "th_1", "aps": ["badge": 2]]
    #expect(NotificationRoute(anyUserInfo: info) == .mail(threadId: "th_1"))
  }

  @Test func roundTripsTheRemindersRoutes() throws {
    let start = try Date("2026-11-09T09:00:00Z", strategy: .iso8601)
    let routes: [NotificationRoute] = [
      .event(id: "ev_1", day: DayKey("2026-11-09"), start: start),
      .event(id: "ev_2", day: DayKey("2026-11-10"), start: nil),
      .tasks(day: DayKey("2026-11-09")),
    ]
    #expect(routes.map { NotificationRoute(userInfo: $0.userInfo) } == routes)
  }

  @Test func ignoresAKindItDoesNotKnow() {
    #expect(NotificationRoute(userInfo: ["kind": "drive", "nodeId": "dn_1"]) == nil)
    #expect(NotificationRoute(userInfo: ["kind": "mail"]) == nil)
  }
}

struct ReminderPlanTests {
  private let zone = TimeZone(identifier: "Europe/Amsterdam") ?? .gmt

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    calendar.locale = Locale(identifier: "en_GB")
    return calendar
  }

  private func at(_ iso: String) throws -> Date { try Date(iso, strategy: .iso8601) }

  private func occurrence(
    _ id: String, title: String = "Standup", start: String, allDay: Bool = false,
    status: AttendeeStatus? = nil, location: String = ""
  ) throws -> EventOccurrence {
    let begins = try at(start)
    let event = EventView(
      id: id, owner: Person(id: "u_1", name: "Ada"), mine: true, title: title, description: "",
      location: location, startsAt: begins, endsAt: begins.addingTimeInterval(allDay ? 86_400 : 900),
      allDay: allDay, timeZone: "Europe/Amsterdam", repeat: .none, repeatUntil: nil, attendees: [],
      myStatus: status, updatedAt: begins)
    return EventOccurrence(event: event, key: "\(id):\(start)", start: begins, end: event.endsAt)
  }

  private func task(_ title: String, due: String?, done: Bool = false) throws -> TaskRow {
    TaskRow(
      id: "tk_\(title)", title: title, notes: "", status: done ? .done : .open, priority: .normal,
      dueOn: due.map(DayKey.init), completedAt: nil, github: nil, updatedAt: try at("2026-11-01T00:00:00Z"),
      createdAt: try at("2026-11-01T00:00:00Z"))
  }

  @Test func remindsBeforeATimedEventInTheReadersZone() throws {
    let plan = ReminderPlan.plan(
      events: [try occurrence("ev_1", start: "2026-11-09T09:00:00Z", location: "Room 4")], tasks: [],
      settings: ReminderSettings(events: true, eventLeadMinutes: 15), now: try at("2026-11-06T12:00:00Z"),
      calendar: calendar)
    let reminder = try #require(plan.first)
    #expect(reminder.fireAt == (try at("2026-11-09T08:45:00Z")))
    #expect([reminder.title, reminder.subtitle, reminder.body] == ["Standup", "Room 4", "In 15 minutes, at 10:00"])
    #expect(reminder.route == .event(id: "ev_1", day: DayKey("2026-11-09"), start: try at("2026-11-09T09:00:00Z")))
  }

  @Test func remindsOfAnAllDayEventOnItsMorningAndSkipsADeclinedOne() throws {
    let plan = ReminderPlan.plan(
      events: [
        try occurrence("ev_day", title: "Offsite", start: "2026-11-10T00:00:00Z", allDay: true),
        try occurrence("ev_no", start: "2026-11-09T09:00:00Z", status: .declined),
      ],
      tasks: [], settings: ReminderSettings(events: true, morningHour: 7, morningMinute: 30),
      now: try at("2026-11-06T12:00:00Z"), calendar: calendar)
    #expect(plan.map(\.title) == ["Offsite"])
    #expect(plan.first?.fireAt == (try at("2026-11-10T06:30:00Z")))
    #expect(plan.first?.body == "All day today")
  }

  @Test func gathersEachMorningsOpenTasksAndLeavesOutThePast() throws {
    let tasks = [
      try task("Send the invoice", due: "2026-11-07"),
      try task("Call Ada", due: "2026-11-07"),
      try task("Done already", due: "2026-11-07", done: true),
      try task("Yesterday", due: "2026-11-05"),
      try task("Someday", due: nil),
      try task("Ship it", due: "2026-11-06"),
    ]
    // 09:30 in Amsterdam: this morning's 08:00 has passed.
    let plan = ReminderPlan.plan(
      events: [], tasks: tasks, settings: ReminderSettings(tasks: true),
      now: try at("2026-11-06T08:30:00Z"), calendar: calendar)
    #expect(plan.map(\.id) == ["reminder.tasks.2026-11-07"])
    #expect([plan.first?.title, plan.first?.body] == ["2 tasks due today", "Call Ada, Send the invoice"])
    #expect(plan.first?.fireAt == (try at("2026-11-07T07:00:00Z")))
  }

  @Test func plansNothingTheSettingsLeaveOffAndAtMostTheLimit() throws {
    let events = try (0..<80).map { index in
      try occurrence("ev_\(index)", start: "2026-11-07T\(String(format: "%02d", index % 24)):0\(index / 24):00Z")
    }
    let off = ReminderPlan.plan(
      events: events, tasks: [], settings: ReminderSettings(), now: try at("2026-11-06T12:00:00Z"),
      calendar: calendar)
    let on = ReminderPlan.plan(
      events: events, tasks: [], settings: ReminderSettings(events: true, eventLeadMinutes: 0),
      now: try at("2026-11-06T12:00:00Z"), calendar: calendar)
    #expect(off.isEmpty)
    #expect(on.count == ReminderPlan.limit)
    #expect(on.map(\.fireAt) == on.map(\.fireAt).sorted())
    #expect(on.first?.body == "Starting now, at 1:00")
  }

  @Test func saysTheLeadInWords() {
    #expect(ReminderSettings.leads.map(ReminderSettings.leadWords) == [
      "0 minutes", "5 minutes", "10 minutes", "15 minutes", "30 minutes", "1 hour",
    ])
  }
}
