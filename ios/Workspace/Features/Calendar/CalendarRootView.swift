import SwiftUI
import WorkspaceKit

/// Calendar: the month grid, then the selected day's agenda or its week, in one list so the
/// large title and pull to refresh behave.
struct CalendarRootView: View {
  @Environment(\.workspaceClient) private var client
  @Environment(AppModel.self) private var app
  @Environment(CreateCenter.self) private var create: CreateCenter?
  @State private var model = CalendarModel()
  /// The event a tapped reminder opens.
  @State private var reminded: EventOccurrence?

  var body: some View {
    List {
      if let error = model.actionError {
        Section {
          ErrorBanner(message: error)
        }
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
      }
      Section {
        CalendarMonthGrid(
          month: model.shownMonth, selectedDay: model.selectedDay, items: model.items,
          onSelect: { model.select($0) }, onMove: { model.moveMonth(by: $0) })
      }
      Section {
        Picker("Show", selection: $model.mode) {
          Text("Day").tag(CalendarModel.Mode.day)
          Text("Week").tag(CalendarModel.Mode.week)
        }
        .pickerStyle(.segmented)
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
      }
      loadStatus
      switch model.mode {
      case .day:
        CalendarDaySections(day: model.selectedDay, items: model.selectedItems)
      case .week:
        CalendarWeekSections(days: model.weekDays, items: model.items)
      }
    }
    .listStyle(.insetGrouped)
    .navigationTitle("Calendar")
    .toolbar {
      // After the Assistant's button, in glass of its own.
      ToolbarSpacer(.fixed, placement: .topBarLeading)
      ToolbarItem(placement: .topBarLeading) {
        Button("Today") { model.goToToday() }
      }
    }
    .tabToolbar()
    // The create menu's new event starts on the selected day.
    .onChange(of: model.selectedDay, initial: true) { _, day in create?.calendarDay = day }
    .navigationDestination(for: EventOccurrence.self) { occurrence in
      // A pushed screen takes its environment from the stack, not from this view: hand the
      // model on, or the event's screen has none to read.
      CalendarEventView(event: occurrence.event, start: occurrence.start, end: occurrence.end)
        .environment(model)
    }
    .navigationDestination(item: $reminded) { occurrence in
      CalendarEventView(event: occurrence.event, start: occurrence.start, end: occurrence.end)
        .environment(model)
    }
    .onChange(of: app.notifications.route, initial: true) { _, route in
      guard case .event(let id, let day, let start) = route else { return }
      app.notifications.route = nil
      model.select(day)
      Task {
        await model.load(client)
        reminded = model.occurrence(of: id, on: day, start: start)
      }
    }
    .task(id: model.shownMonth) { await model.load(client) }
    .task(id: weekLoadKey) {
      guard model.mode == .week else { return }
      await model.loadWeekNeighbors(client)
    }
    .refreshable { await model.reloadAfterChange(client) }
    .reloadsWhileOpen { await model.reloadAfterChange(client) }
    // An event or a task made from the create menu.
    .onChange(of: ChangeSignal.planner.version) { Task { await model.reloadAfterChange(client) } }
    .environment(model)
  }

  /// Changes when the week list needs other months: the selected day while the week is shown.
  private var weekLoadKey: String {
    model.mode == .week ? model.selectedDay.value : ""
  }

  @ViewBuilder private var loadStatus: some View {
    switch model.month {
    case .idle, .loading:
      LoadingSection()
    case .failed(let message, _):
      Section {
        ErrorBanner(message: message) { await model.load(client) }
      }
      .listRowInsets(EdgeInsets())
      .listRowBackground(Color.clear)
    case .loaded:
      EmptyView()
    }
  }
}
