import Foundation

/// Where a tapped notification opens the app, read from its `userInfo`: the new-mail push the
/// Worker sends (`kind` `mail` with its `threadId`, `app/lib/mail/notify.server.ts`), or one of
/// the reminders the app schedules itself (`ReminderPlan`).
public enum NotificationRoute: Hashable, Sendable {
  /// A conversation in Mail.
  case mail(threadId: String)
  /// An event in Calendar, on the day it is shown on; `start` picks the occurrence of a repeat.
  case event(id: String, day: DayKey, start: Date?)
  /// The tasks due on a day.
  case tasks(day: DayKey)

  /// The route a notification's keys name, or nil for one the app does not know.
  public init?(userInfo: [String: String]) {
    switch userInfo["kind"] {
    case "mail":
      guard let threadId = userInfo["threadId"], !threadId.isEmpty else { return nil }
      self = .mail(threadId: threadId)
    case "event":
      guard let id = userInfo["eventId"], let day = userInfo["day"] else { return nil }
      let start = userInfo["start"].flatMap { try? Date($0, strategy: .iso8601) }
      self = .event(id: id, day: DayKey(day), start: start)
    case "tasks":
      guard let day = userInfo["day"] else { return nil }
      self = .tasks(day: DayKey(day))
    default:
      return nil
    }
  }

  /// The keys a reminder carries for `init(userInfo:)`.
  public var userInfo: [String: String] {
    switch self {
    case .mail(let threadId):
      return ["kind": "mail", "threadId": threadId]
    case .event(let id, let day, let start):
      var info = ["kind": "event", "eventId": id, "day": day.value]
      if let start { info["start"] = start.formatted(.iso8601) }
      return info
    case .tasks(let day):
      return ["kind": "tasks", "day": day.value]
    }
  }
}

extension NotificationRoute {
  /// The string keys among a notification's `userInfo`, which may hold anything.
  public init?(anyUserInfo: [AnyHashable: Any]) {
    var strings: [String: String] = [:]
    for (key, value) in anyUserInfo {
      if let key = key as? String, let value = value as? String {
        strings[key] = value
      }
    }
    self.init(userInfo: strings)
  }
}
