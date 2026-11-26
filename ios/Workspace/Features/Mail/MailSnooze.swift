import Foundation

/// A moment the snooze menu offers.
struct MailSnoozePreset: Identifiable {
  let id: String
  let title: String
  let date: Date
}

/// The moments the snooze menu offers, in the reader's zone: the console's `snoozePresets`.
enum MailSnooze {
  private static let morning = 8
  private static let evening = 18
  private static let soonEnough: TimeInterval = 90 * 60
  private static let threeHours: TimeInterval = 3 * 3600

  static func presets(now: Date = .now, calendar: Calendar = .current) -> [MailSnoozePreset] {
    var presets: [MailSnoozePreset] = []
    // Later today: the evening, or three hours on when the evening is near or gone.
    let eveningToday = at(now, days: 0, hour: evening, calendar)
    let laterToday =
      eveningToday.timeIntervalSince(now) > soonEnough ? eveningToday : now.addingTimeInterval(threeHours)
    if calendar.isDate(laterToday, inSameDayAs: now) {
      presets.append(MailSnoozePreset(id: "later", title: "Later today", date: laterToday))
    }
    presets.append(
      MailSnoozePreset(id: "tomorrow", title: "Tomorrow morning", date: at(now, days: 1, hour: morning, calendar)))
    // Sunday is 0, as the console counts; this weekend is Saturday morning, from Saturday on the next one.
    let day = calendar.component(.weekday, from: now) - 1
    let toSaturday = day == 6 ? 7 : 6 - day
    presets.append(
      MailSnoozePreset(id: "weekend", title: "This weekend", date: at(now, days: toSaturday, hour: morning, calendar)))
    let toMonday = day == 0 ? 1 : 8 - day
    presets.append(
      MailSnoozePreset(id: "week", title: "Next week", date: at(now, days: toMonday, hour: morning, calendar)))
    var seen: Set<Date> = []
    return presets.filter { seen.insert($0.date).inserted }
  }

  /// Tomorrow morning: where the date picker starts.
  static func defaultCustom(now: Date = .now, calendar: Calendar = .current) -> Date {
    at(now, days: 1, hour: morning, calendar)
  }

  private static func at(_ base: Date, days: Int, hour: Int, _ calendar: Calendar) -> Date {
    let day = calendar.date(byAdding: .day, value: days, to: base) ?? base
    return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day) ?? day
  }

  /// "Today, 6:00 PM", "Tomorrow, 8:00 AM", "Sat, 8:00 AM" or "Nov 8, 8:00 AM": a snooze moment as
  /// the row and the menu show it.
  static func label(_ date: Date, now: Date = .now, calendar: Calendar = .current) -> String {
    let time = date.formatted(date: .omitted, time: .shortened)
    if calendar.isDate(date, inSameDayAs: now) { return "Today, \(time)" }
    if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(date, inSameDayAs: tomorrow) {
      return "Tomorrow, \(time)"
    }
    if date.timeIntervalSince(now) < 7 * 86_400 {
      return "\(date.formatted(.dateTime.weekday(.abbreviated))), \(time)"
    }
    let sameYear = calendar.isDate(date, equalTo: now, toGranularity: .year)
    let day =
      sameYear
      ? date.formatted(.dateTime.month(.abbreviated).day())
      : date.formatted(.dateTime.month(.abbreviated).day().year())
    return "\(day), \(time)"
  }
}
