import SwiftUI

/// When a conversation comes back: the presets, or a moment of the person's choosing.
struct MailSnoozePicker: View {
  let onPick: (Date) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var custom = MailSnooze.defaultCustom()

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(MailSnooze.presets()) { preset in
            Button {
              pick(preset.date)
            } label: {
              HStack {
                Text(preset.title)
                Spacer()
                Text(MailSnooze.label(preset.date))
                  .foregroundStyle(.secondary)
              }
            }
            .foregroundStyle(.primary)
          }
        }
        Section("Pick a date") {
          DatePicker("Until", selection: $custom, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
        }
      }
      .navigationTitle("Snooze")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Snooze") { pick(custom) }
            .prominentAction()
        }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private func pick(_ date: Date) {
    dismiss()
    onPick(date)
  }
}
