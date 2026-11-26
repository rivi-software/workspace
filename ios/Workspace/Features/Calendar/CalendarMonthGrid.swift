import SwiftUI
import WorkspaceKit

/// A month as seven columns from the locale's first weekday: today ringed, the selected day
/// filled, a dot under a day with something on it. Arrows or a horizontal swipe move a month.
struct CalendarMonthGrid: View {
  let month: PlannerMonth
  let selectedDay: DayKey
  let items: [DayKey: PlannerDayItems]
  let onSelect: (DayKey) -> Void
  let onMove: (Int) -> Void

  private let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: 7)
  private let today = PlannerDay.today

  var body: some View {
    VStack(spacing: 10) {
      HStack {
        Button {
          onMove(-1)
        } label: {
          Image(systemName: "chevron.left")
            .font(.body.weight(.semibold))
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Previous month")
        Spacer()
        Text(month.title)
          .font(.title3.weight(.semibold))
          .contentTransition(.numericText())
        Spacer()
        Button {
          onMove(1)
        } label: {
          Image(systemName: "chevron.right")
            .font(.body.weight(.semibold))
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Next month")
      }
      .buttonStyle(.borderless)
      LazyVGrid(columns: columns, spacing: 4) {
        ForEach(PlannerDay.weekdaySymbols, id: \.self) { symbol in
          Text(symbol.uppercased())
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.tertiary)
            .lineLimit(1)
        }
        ForEach(0..<month.leadingBlanks, id: \.self) { _ in
          Color.clear
            .frame(height: 44)
        }
        ForEach(1...month.dayCount, id: \.self) { number in
          let day = month.day(number)
          CalendarDayCell(
            number: number, isToday: day == today, isSelected: day == selectedDay,
            count: items[day]?.count ?? 0, label: PlannerDay.longLabel(day)
          ) {
            onSelect(day)
          }
        }
      }
    }
    .padding(.vertical, 4)
    // Seven columns of fixed cells hold no larger type; the day's agenda below carries it.
    .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    .gesture(
      DragGesture(minimumDistance: 40).onEnded { value in
        guard abs(value.translation.width) > abs(value.translation.height) else { return }
        onMove(value.translation.width < 0 ? 1 : -1)
      })
  }
}

/// One day of the grid.
private struct CalendarDayCell: View {
  let number: Int
  let isToday: Bool
  let isSelected: Bool
  let count: Int
  /// What VoiceOver reads.
  let label: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 2) {
        Text("\(number)")
          .font(.callout.weight(isToday || isSelected ? .semibold : .regular))
          .monospacedDigit()
          .foregroundStyle(numberColor)
          .frame(width: 34, height: 34)
          .background {
            if isSelected {
              Circle().fill(Theme.accent)
            } else if isToday {
              Circle().strokeBorder(Theme.accent, lineWidth: 1.5)
            }
          }
        Circle()
          .fill(count > 0 ? Theme.accent : Color.clear)
          .frame(width: 5, height: 5)
      }
      .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderless)
    .accessibilityLabel(label)
    .accessibilityValue(accessibilityValue)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  private var numberColor: Color {
    if isSelected { return Theme.onAccent }
    if isToday { return Theme.accent }
    return Theme.foreground
  }

  private var accessibilityValue: String {
    switch count {
    case 0: isToday ? "Today, nothing planned" : "Nothing planned"
    case 1: isToday ? "Today, 1 item" : "1 item"
    default: isToday ? "Today, \(count) items" : "\(count) items"
    }
  }
}
