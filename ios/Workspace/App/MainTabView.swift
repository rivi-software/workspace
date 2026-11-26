import SwiftUI
import WorkspaceKit

/// The app's tabs, which a tapped notification selects.
enum AppTab: Hashable {
  case mail, drive, calendar, tasks
}

/// The Liquid Glass tab bar: one tab per feature, each in a NavigationStack of its own, the inbox's
/// unread count on Mail. The bar stays full as the content scrolls: iOS tells a screen neither
/// when it shrinks to a circle nor when it grows back. Every tab's root carries the Assistant and
/// the create menu in its toolbar (`tabToolbar`); what the menu asks for opens here, over
/// whichever tab is on show (`createFlows`). A tapped notification (`NotificationsModel.route`)
/// selects its tab: a conversation opens on Mail's stack, an event in Calendar
/// (`CalendarRootView` takes the route from here).
struct MainTabView: View {
  @Environment(AppModel.self) private var app
  @State private var tab: AppTab = .mail
  @State private var mailPath = NavigationPath()
  @State private var create = CreateCenter()

  var body: some View {
    TabView(selection: $tab) {
      Tab("Mail", systemImage: "envelope", value: AppTab.mail) {
        NavigationStack(path: $mailPath) { MailRootView() }
          .environment(\.appTab, .mail)
      }
      .badge(app.inboxUnread)

      Tab("Drive", systemImage: "folder", value: AppTab.drive) {
        NavigationStack { DriveRootView() }
          .environment(\.appTab, .drive)
      }

      Tab("Calendar", systemImage: "calendar", value: AppTab.calendar) {
        NavigationStack { CalendarRootView() }
          .environment(\.appTab, .calendar)
      }

      Tab("Tasks", systemImage: "checklist", value: AppTab.tasks) {
        NavigationStack { TasksRootView() }
          .environment(\.appTab, .tasks)
      }
    }
    .tabBarMinimizeBehavior(.never)
    .environment(create)
    .createFlows($create.request)
    .onChange(of: app.notifications.route, initial: true) { _, route in
      follow(route)
    }
  }

  private func follow(_ route: NotificationRoute?) {
    switch route {
    case .mail(let threadId):
      tab = .mail
      var path = NavigationPath()
      path.append(MailThreadDestination(id: threadId))
      mailPath = path
      app.notifications.route = nil
    case .event:
      tab = .calendar
    case .tasks:
      tab = .tasks
      app.notifications.route = nil
    case nil:
      break
    }
  }
}
