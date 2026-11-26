import SwiftUI
import UIKit
import WorkspaceKit

/// Settings' notifications: the reminders the phone plans itself (events before they start, and
/// each morning the tasks due that day). Each switch asks for permission
/// the first time; once it was refused, the footer leads to the system's settings.
struct NotificationSettingsSection: View {
  @Environment(AppModel.self) private var app
  @Environment(\.openURL) private var openURL

  private var notifications: NotificationsModel { app.notifications }

  var body: some View {
    Section {
      Toggle("Calendar events", isOn: reminderBinding(\.events))
      if notifications.reminders.events {
        Picker("Remind me", selection: reminderBinding(\.eventLeadMinutes)) {
          ForEach(ReminderSettings.leads, id: \.self) { minutes in
            Text(leadLabel(minutes)).tag(minutes)
          }
        }
      }
      Toggle("Tasks due today", isOn: reminderBinding(\.tasks))
      if notifications.reminders.events || notifications.reminders.tasks {
        DatePicker("Morning reminders", selection: morningBinding, displayedComponents: .hourAndMinute)
      }
    } header: {
      Text("Notifications")
    } footer: {
      footer
    }
    .task { await notifications.refreshPermission() }
  }

  @ViewBuilder private var footer: some View {
    if notifications.permission == .denied {
      VStack(alignment: .leading, spacing: 6) {
        Text("Notifications are off for Workspace on this iPhone.")
        Button("Turn them on in Settings") {
          if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
            openURL(url)
          }
        }
        .font(.footnote.weight(.semibold))
      }
    } else {
      Text("All-day events and tasks due that day remind you at the morning time.")
    }
  }

  private func leadLabel(_ minutes: Int) -> String {
    minutes == 0 ? "When it starts" : "\(ReminderSettings.leadWords(minutes)) before"
  }

  // MARK: Bindings

  private func reminderBinding<Value: Sendable>(_ key: WritableKeyPath<ReminderSettings, Value>) -> Binding<Value> {
    Binding(
      get: { notifications.reminders[keyPath: key] },
      set: { value in
        var next = notifications.reminders
        next[keyPath: key] = value
        Task { await notifications.setReminders(next) }
      })
  }

  /// The morning time as a date today, which the picker shows as a time.
  private var morningBinding: Binding<Date> {
    Binding(
      get: {
        let settings = notifications.reminders
        return Calendar.current.date(
          bySettingHour: settings.morningHour, minute: settings.morningMinute, second: 0, of: Date())
          ?? Date()
      },
      set: { date in
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        var next = notifications.reminders
        next.morningHour = parts.hour ?? next.morningHour
        next.morningMinute = parts.minute ?? next.morningMinute
        Task { await notifications.setReminders(next) }
      })
  }
}
