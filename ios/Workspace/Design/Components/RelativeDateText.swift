import SwiftUI

/// A moment as a mail list shows it: the time today, the weekday this week, the day and month
/// this year, the full date before that.
struct RelativeDateText: View {
  let date: Date

  var body: some View {
    Text(label)
      .monospacedDigit()
      .accessibilityLabel(date.formatted(date: .abbreviated, time: .shortened))
  }

  private var label: String {
    let now = Date()
    let calendar = Calendar.current
    if abs(now.timeIntervalSince(date)) < 60 { return "Now" }
    if calendar.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
    if abs(now.timeIntervalSince(date)) < 6 * 86_400 {
      return date.formatted(.dateTime.weekday(.abbreviated))
    }
    if calendar.isDate(date, equalTo: now, toGranularity: .year) {
      return date.formatted(.dateTime.day().month(.abbreviated))
    }
    return date.formatted(.dateTime.day().month(.abbreviated).year())
  }
}
