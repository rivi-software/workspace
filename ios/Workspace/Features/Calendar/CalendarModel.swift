import Foundation
import Observation
import WorkspaceKit

/// Calendar's state: the selected day, the shown month, every month loaded so far, and the items
/// placed on their days. One `/calendar` call per month, a day of leeway each side.
@Observable @MainActor
final class CalendarModel {
  enum Mode: Hashable {
    case day, week
  }

  var selectedDay: DayKey = PlannerDay.today
  private(set) var shownMonth: PlannerMonth = .current
  var mode: Mode = .day
  /// The shown month's data.
  var month: LoadState<CalendarData> = .idle
  /// What the last action (an answer, a deletion, a task marked done) said went wrong.
  var actionError: String?
  /// Every day's items, from every month in the cache.
  private(set) var items: [DayKey: PlannerDayItems] = [:]

  @ObservationIgnored private var cache: [String: CalendarData] = [:]

  var selectedItems: PlannerDayItems { items[selectedDay] ?? .empty }

  /// The seven days of the selected day's week.
  var weekDays: [DayKey] { PlannerDay.week(of: selectedDay) }

  func items(on day: DayKey) -> PlannerDayItems { items[day] ?? .empty }

  /// The occurrence of an event on a day, the one starting at `start` when it repeats.
  func occurrence(of eventId: String, on day: DayKey, start: Date?) -> EventOccurrence? {
    let shown = items(on: day)
    return (shown.allDay + shown.timed).first { occurrence in
      occurrence.event.id == eventId && (start == nil || occurrence.start == start)
    }
  }

  // MARK: Moving around

  /// Shows a month; the selection moves into it when it was elsewhere. A cached month shows at
  /// once and the view reloads it.
  func show(_ month: PlannerMonth) {
    guard month != shownMonth else { return }
    shownMonth = month
    if !month.contains(selectedDay) {
      selectedDay = month == .current ? PlannerDay.today : month.firstDay
    }
    if let cached = cache[month.key] {
      self.month = .loaded(cached)
    } else {
      self.month = .idle
    }
  }

  func moveMonth(by months: Int) {
    show(shownMonth.adding(months))
  }

  func select(_ day: DayKey) {
    selectedDay = day
    if !shownMonth.contains(day) {
      show(PlannerMonth(containing: day))
    }
  }

  func goToToday() {
    select(PlannerDay.today)
  }

  // MARK: Loading

  /// Loads the shown month; what is cached stays on screen while it runs. A month that stopped
  /// being the shown one during the call still lands in the cache.
  func load(_ client: WorkspaceClient) async {
    let target = shownMonth
    month.begin()
    do {
      let data = try await client.calendar(from: target.loadFrom, to: target.loadTo)
      cache[target.key] = data
      rebuildItems()
      if target == shownMonth {
        month.finish(data)
      }
    } catch {
      if target == shownMonth {
        month.fail(error)
      }
    }
  }

  /// Loads the months the selected week reaches into beyond the shown one, for the week list.
  /// A failure here shows nothing: the shown month's own state carries the words.
  func loadWeekNeighbors(_ client: WorkspaceClient) async {
    let neighbors = Set(weekDays.map { PlannerMonth(containing: $0) }).subtracting([shownMonth])
    for neighbor in neighbors where cache[neighbor.key] == nil {
      guard let data = try? await client.calendar(from: neighbor.loadFrom, to: neighbor.loadTo) else {
        continue
      }
      cache[neighbor.key] = data
      rebuildItems()
    }
  }

  /// After a change every cached month is stale: forget them and read the shown one again, and
  /// the week's neighbors when the week is shown.
  func reloadAfterChange(_ client: WorkspaceClient) async {
    cache.removeAll()
    await load(client)
    if mode == .week {
      await loadWeekNeighbors(client)
    }
  }

  private func rebuildItems() {
    items = PlannerDayItems.place(Array(cache.values))
  }

  // MARK: Changes

  /// Answers an invitation; the event comes back as the server has it now.
  func respond(_ client: WorkspaceClient, eventId: String, status: AttendeeStatus) async throws
    -> EventView
  {
    let event = try await client.respond(eventId: eventId, status: status)
    await reloadAfterChange(client)
    return event
  }

  func deleteEvent(_ client: WorkspaceClient, id: String) async throws {
    _ = try await client.deleteEvent(id: id)
    await reloadAfterChange(client)
  }

  /// Marks a task due on the agenda done or open; the server's words land in `actionError`.
  func setTaskDone(_ client: WorkspaceClient, task: TaskRow, done: Bool) async {
    actionError = nil
    do {
      _ = try await client.setTaskDone(id: task.id, done: done)
      await reloadAfterChange(client)
    } catch {
      actionError = failureMessage(error)
    }
  }
}
