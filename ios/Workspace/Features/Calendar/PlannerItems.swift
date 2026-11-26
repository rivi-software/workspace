import Foundation
import WorkspaceKit

/// A task's priority as a rank, and the open list's order.
enum PlannerPriority {
  static func rank(_ priority: TaskPriority) -> Int {
    switch priority {
    case .high: 0
    case .normal: 1
    case .low: 2
    case .other: 3
    }
  }

  /// Due day first (none last), then priority, then creation.
  static func before(_ lhs: TaskRow, _ rhs: TaskRow) -> Bool {
    let lhsDue = lhs.dueOn?.value ?? "9999-99-99"
    let rhsDue = rhs.dueOn?.value ?? "9999-99-99"
    if lhsDue != rhsDue { return lhsDue < rhsDue }
    let lhsRank = rank(lhs.priority)
    let rhsRank = rank(rhs.priority)
    if lhsRank != rhsRank { return lhsRank < rhsRank }
    return lhs.createdAt < rhs.createdAt
  }
}

/// What one day holds, in the agenda's order: all-day events, timed events, tasks due.
struct PlannerDayItems: Hashable, Sendable {
  var allDay: [EventOccurrence] = []
  var timed: [EventOccurrence] = []
  var tasks: [TaskRow] = []

  static let empty = PlannerDayItems()

  var isEmpty: Bool { allDay.isEmpty && timed.isEmpty && tasks.isEmpty }
  var count: Int { allDay.count + timed.count + tasks.count }

  /// Places every item of the loaded months on its days. Months overlap by their leeway days, so
  /// an occurrence or a task seen twice counts once.
  static func place(_ months: [CalendarData]) -> [DayKey: PlannerDayItems] {
    var items: [DayKey: PlannerDayItems] = [:]
    var occurrences: Set<String> = []
    var tasks: Set<String> = []
    for month in months {
      for occurrence in month.events where occurrences.insert(occurrence.key).inserted {
        for day in days(of: occurrence) {
          if occurrence.event.allDay {
            items[day, default: .empty].allDay.append(occurrence)
          } else {
            items[day, default: .empty].timed.append(occurrence)
          }
        }
      }
      for task in month.tasks where tasks.insert(task.id).inserted {
        guard let due = task.dueOn else { continue }
        items[due, default: .empty].tasks.append(task)
      }
    }
    for day in items.keys {
      items[day]?.sort()
    }
    return items
  }

  /// The days an occurrence touches: an all-day one by its UTC dates, a timed one by each local
  /// day from its start to its end.
  static func days(of occurrence: EventOccurrence) -> [DayKey] {
    if occurrence.event.allDay {
      let first = DayKey(occurrence.start, in: .gmt)
      let afterLast = DayKey(occurrence.end, in: .gmt)
      let last = afterLast > first ? PlannerDay.adding(-1, to: afterLast) : first
      return PlannerDay.days(from: first, through: last)
    }
    let first = DayKey(occurrence.start)
    let lastMoment =
      occurrence.end > occurrence.start ? occurrence.end.addingTimeInterval(-1) : occurrence.start
    let last = max(first, DayKey(lastMoment))
    return PlannerDay.days(from: first, through: last)
  }

  private mutating func sort() {
    allDay.sort { ($0.start, $0.event.title) < ($1.start, $1.event.title) }
    timed.sort { ($0.start, $0.event.title) < ($1.start, $1.event.title) }
    tasks.sort(by: PlannerPriority.before)
  }
}
