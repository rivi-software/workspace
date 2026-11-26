import UIKit
import UserNotifications
import WorkspaceKit

/// The system's callbacks SwiftUI has no modifier for: the reminders the person sees while the app
/// is open or taps to open it. What arrives before `WorkspaceApp` connects the notifications model
/// (a tap that launched the app) waits here.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  private var notifications: NotificationsModel?
  private var pendingRoute: NotificationRoute?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  func connect(_ notifications: NotificationsModel) {
    self.notifications = notifications
    if let route = pendingRoute {
      pendingRoute = nil
      notifications.open(route)
    }
  }

  /// A notification while the app is open shows as it would outside it. The completion-handler
  /// forms, answered on the main actor: an `async` one returns off the main thread, and UIKit,
  /// which answers the system from there, threw "Call must be made on main thread" on a tap.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void
  ) {
    Task { @MainActor in
      completionHandler([.banner, .list, .sound, .badge])
    }
  }

  /// A tap: the route its keys name, for the tabs to follow.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping @Sendable () -> Void
  ) {
    let route = NotificationRoute(anyUserInfo: response.notification.request.content.userInfo)
    Task { @MainActor in
      if let route { open(route) }
      completionHandler()
    }
  }

  private func open(_ route: NotificationRoute) {
    guard let notifications else {
      pendingRoute = route
      return
    }
    notifications.open(route)
  }
}
