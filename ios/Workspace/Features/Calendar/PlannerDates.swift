import Foundation
import WorkspaceKit

// Days and months for Calendar and Tasks. A day is a `DayKey` in the reader's zone, built through
// `Calendar.current`, never through UTC; only an all-day event's dates are read as UTC.

/// A month of the grid as a year and a month number, with its days and the range it loads.
struct PlannerMonth: Hashable, Sendable {
  let year: Int
  let month: Int

  init(year: Int, month: Int) {
    self.year = year
    self.month = month
  }

  /// The month `day` falls in.
  init(containing day: DayKey) {
    let parts = day.value.split(separator: "-").compactMap { Int($0) }
    year = parts.first ?? 1970
    month = parts.count > 1 ? parts[1] : 1
  }

  static var current: PlannerMonth { PlannerMonth(containing: PlannerDay.today) }

  /// `YYYY-MM`: the cache's key and the prefix of every day in the month.
  var key: String { String(format: "%04d-%02d", year, month) }

  var firstDay: DayKey { day(1) }

  /// Day `number` of this month.
  func day(_ number: Int) -> DayKey {
    DayKey(String(format: "%04d-%02d-%02d", year, month, number))
  }

  /// The first day's local midnight.
  var start: Date { firstDay.date() ?? Date() }

  var dayCount: Int { Calendar.current.range(of: .day, in: .month, for: start)?.count ?? 30 }

  /// "November 2026".
  var title: String { start.formatted(.dateTime.month(.wide).year()) }

  /// Empty cells before the first day, the week starting on the locale's first weekday.
  var leadingBlanks: Int {
    let calendar = Calendar.current
    let weekday = calendar.component(.weekday, from: start)
    return (weekday - calendar.firstWeekday + 7) % 7
  }

  func adding(_ months: Int) -> PlannerMonth {
    let moved = Calendar.current.date(byAdding: .month, value: months, to: start) ?? start
    return PlannerMonth(containing: DayKey(moved))
  }

  func contains(_ day: DayKey) -> Bool { day.value.hasPrefix(key + "-") }

  /// What `/calendar` is asked for: the month with a day of leeway each side, `to` excluded.
  var loadFrom: DayKey { PlannerDay.adding(-1, to: firstDay) }
  var loadTo: DayKey { PlannerDay.adding(1, to: adding(1).firstDay) }
}

/// Days in the reader's zone.
enum PlannerDay {
  static var today: DayKey { DayKey(Date()) }

  static func adding(_ days: Int, to day: DayKey) -> DayKey {
    guard let date = day.date() else { return day }
    let moved = Calendar.current.date(byAdding: .day, value: days, to: date) ?? date
    return DayKey(moved)
  }

  /// `from` through `to`, both included, capped at a year.
  static func days(from: DayKey, through to: DayKey) -> [DayKey] {
    var days: [DayKey] = []
    var day = from
    while day <= to, days.count < 366 {
      days.append(day)
      day = adding(1, to: day)
    }
    return days
  }

  /// How many days `to` lies after `from`; negative when before.
  static func distance(from: DayKey, to: DayKey) -> Int {
    guard let start = from.date(), let end = to.date() else { return 0 }
    return Calendar.current.dateComponents([.day], from: start, to: end).day ?? 0
  }

  /// The seven days of the week `day` falls in, from the locale's first weekday.
  static func week(of day: DayKey) -> [DayKey] {
    guard let date = day.date(),
      let interval = Calendar.current.dateInterval(of: .weekOfYear, for: date)
    else { return [day] }
    let first = DayKey(interval.start)
    return (0..<7).map { adding($0, to: first) }
  }

  /// The weekday names from the locale's first weekday, for the grid's header.
  static var weekdaySymbols: [String] {
    let calendar = Calendar.current
    let symbols = calendar.shortStandaloneWeekdaySymbols
    guard symbols.count == 7 else { return symbols }
    let shift = (calendar.firstWeekday - 1 + 7) % 7
    return (0..<7).map { symbols[($0 + shift) % 7] }
  }

  /// The last moment of `day`, just before the next one starts.
  static func end(of day: DayKey) -> Date? {
    guard let next = adding(1, to: day).date() else { return nil }
    return next.addingTimeInterval(-1)
  }

  /// "Mon, Nov 10" in the locale's order.
  static func shortLabel(_ day: DayKey) -> String {
    guard let date = day.date() else { return day.value }
    return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
  }

  /// "Monday, November 10, 2026".
  static func longLabel(_ day: DayKey) -> String {
    guard let date = day.date() else { return day.value }
    return date.formatted(date: .complete, time: .omitted)
  }

  /// "Today", "Tomorrow", "Yesterday", else the short label, with the year when it is another.
  static func relativeLabel(_ day: DayKey) -> String {
    switch distance(from: today, to: day) {
    case 0: return "Today"
    case 1: return "Tomorrow"
    case -1: return "Yesterday"
    default: break
    }
    guard let date = day.date() else { return day.value }
    if Calendar.current.isDate(date, equalTo: Date(), toGranularity: .year) {
      return shortLabel(day)
    }
    return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).year())
  }

  /// A task's due label: "Today", "Tomorrow", "3 days overdue", else the day.
  static func dueLabel(_ day: DayKey) -> String {
    let gap = distance(from: today, to: day)
    if gap < 0 {
      return gap == -1 ? "1 day overdue" : "\(-gap) days overdue"
    }
    return relativeLabel(day)
  }
}

/// Moments as the agenda writes them.
enum PlannerTime {
  static func clock(_ date: Date) -> String {
    date.formatted(date: .omitted, time: .shortened)
  }

  /// "09:00 to 10:00" on one day; with the days when the span crosses one.
  static func span(_ start: Date, _ end: Date) -> String {
    let startDay = DayKey(start)
    let endDay = DayKey(end > start ? end.addingTimeInterval(-1) : end)
    if startDay == endDay {
      return "\(clock(start)) to \(clock(end))"
    }
    return
      "\(PlannerDay.shortLabel(startDay)), \(clock(start)) to \(PlannerDay.shortLabel(endDay)), \(clock(end))"
  }

  /// The days of an all-day event, read as UTC dates: the day, or "Mon, Nov 10 to Wed, Nov 12".
  static func allDaySpan(_ start: Date, _ end: Date) -> String {
    let first = DayKey(start, in: .gmt)
    let afterLast = DayKey(end, in: .gmt)
    let last = afterLast > first ? PlannerDay.adding(-1, to: afterLast) : first
    if first == last { return PlannerDay.longLabel(first) }
    return "\(PlannerDay.shortLabel(first)) to \(PlannerDay.shortLabel(last))"
  }
}
