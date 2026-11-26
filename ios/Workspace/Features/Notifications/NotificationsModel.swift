import Foundation
import Observation
import UIKit
import UserNotifications
import WorkspaceKit

/// The app's notifications: the reminders of events and of tasks due, which the app schedules on
/// the phone itself (`ReminderPlan`) from what the API answers. This workspace's Worker sends no
/// push, so there is no notification of new mail and no device to register. The choices stay on
/// the phone; a tapped notification's `route` is where the tabs go next. `AppModel` owns it and
/// hands it the client, since the system's callbacks (`AppDelegate`) come without one.
@Observable @MainActor
final class NotificationsModel {
  enum Permission: Equatable {
    case unknown, notAsked, allowed, denied
  }

  private(set) var permission: Permission = .unknown
  private(set) var reminders: ReminderSettings
  /// Where a tapped notification opens the app; the tabs take it and set it back to nil.
  var route: NotificationRoute?

  @ObservationIgnored private var client: WorkspaceClient?
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private let center = UNUserNotificationCenter.current()

  private enum Key {
    static let reminders = "notifications.reminders"
  }

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    reminders =
      defaults.data(forKey: Key.reminders).flatMap { try? JSONDecoder().decode(ReminderSettings.self, from: $0) }
      ?? ReminderSettings()
  }

  /// The client of the workspace signed in to; a new one after a sign-in to another workspace.
  func attach(_ client: WorkspaceClient) {
    self.client = client
  }

  // MARK: Signed in and out

  /// On launch and after a sign-in: plan the reminders.
  func signedIn() async {
    await refreshPermission()
    await scheduleReminders()
  }

  /// Back in the front: the permission may have changed in Settings, and the days moved on.
  func cameForward() async {
    await refreshPermission()
    await scheduleReminders()
  }

  /// Signed out, here or by the workspace: the phone forgets the reminders of that workspace.
  func signedOut() {
    Task {
      await clearReminders()
      try? await center.setBadgeCount(0)
    }
  }

  // MARK: Choices

  /// Saves the reminders' settings, asking for permission when one is turned on, and plans again.
  func setReminders(_ settings: ReminderSettings) async {
    var next = settings
    if (next.events && !reminders.events) || (next.tasks && !reminders.tasks) {
      if !(await ensurePermission()) {
        next.events = reminders.events
        next.tasks = reminders.tasks
      }
    }
    reminders = next
    defaults.set(try? JSONEncoder().encode(next), forKey: Key.reminders)
    await scheduleReminders()
  }

  // MARK: The system's callbacks

  func open(_ route: NotificationRoute) {
    self.route = route
  }

  // MARK: Permission

  func refreshPermission() async {
    let settings = await center.notificationSettings()
    switch settings.authorizationStatus {
    case .notDetermined: permission = .notAsked
    case .denied: permission = .denied
    case .authorized, .provisional, .ephemeral: permission = .allowed
    @unknown default: permission = .denied
    }
  }

  /// Whether the app may notify, asking the person the first time.
  private func ensurePermission() async -> Bool {
    await refreshPermission()
    if permission == .notAsked {
      _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
      await refreshPermission()
    }
    return permission == .allowed
  }

  // MARK: Reminders

  /// Replaces the pending reminders with a plan from the events and open tasks of the coming
  /// days. A load that fails keeps the reminders already planned.
  func scheduleReminders() async {
    guard let client, permission == .allowed, reminders.events || reminders.tasks else {
      await clearReminders()
      return
    }
    let now = Date()
    let calendar = Calendar.current
    let from = DayKey(calendar.date(byAdding: .day, value: -1, to: now) ?? now)
    let to = DayKey(calendar.date(byAdding: .day, value: ReminderPlan.horizonDays + 2, to: now) ?? now)
    let events: [EventOccurrence]
    let tasks: [TaskRow]
    do {
      events = reminders.events ? try await client.calendar(from: from, to: to).events : []
      tasks = reminders.tasks ? try await client.tasks(view: .open).tasks : []
    } catch {
      return
    }
    let plan = ReminderPlan.plan(
      events: events, tasks: tasks, settings: reminders, now: now, calendar: calendar)
    await clearReminders()
    for reminder in plan {
      try? await center.add(request(for: reminder, calendar: calendar))
    }
  }

  /// Removes the reminders this app planned; anything else pending stays.
  private func clearReminders() async {
    let pending = await center.pendingNotificationRequests()
    let ours = pending.map(\.identifier).filter { $0.hasPrefix(ReminderPlan.identifierPrefix) }
    center.removePendingNotificationRequests(withIdentifiers: ours)
  }

  private func request(for reminder: PlannedReminder, calendar: Calendar) -> UNNotificationRequest {
    let content = UNMutableNotificationContent()
    content.title = reminder.title
    content.subtitle = reminder.subtitle
    content.body = reminder.body
    content.sound = .default
    content.threadIdentifier = reminder.group
    content.userInfo = reminder.route.userInfo
    let when = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: reminder.fireAt)
    let trigger = UNCalendarNotificationTrigger(dateMatching: when, repeats: false)
    return UNNotificationRequest(identifier: reminder.id, content: content, trigger: trigger)
  }
}
