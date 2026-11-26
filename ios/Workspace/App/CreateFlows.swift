import SwiftUI
import WorkspaceKit

/// What the create menu asked for: what to make, and where.
struct CreateRequest: Equatable {
  let kind: CreateKind
  /// The Drive folder a new folder or an upload goes to, "" for My Drive.
  var driveFolderId = ""
  /// The day a new event starts on, nil for today.
  var day: DayKey?
}

/// Between the create menus in the tabs' toolbars and `createFlows` in `MainTabView`: the request,
/// and where it lands when its tab is on show, the Drive folder the person may write to and the
/// day Calendar has selected. The tabs tell it as they show; from another tab a folder or an
/// upload goes to My Drive and an event to today.
@Observable @MainActor
final class CreateCenter {
  /// The last request, until `createFlows` opens it.
  var request: CreateRequest?
  /// The folder the Drive listing on show adds to, "" for My Drive; nil when it takes nothing.
  var driveFolderId: String?
  var calendarDay: DayKey?

  func create(_ kind: CreateKind, from tab: AppTab) {
    request = CreateRequest(
      kind: kind,
      driveFolderId: tab == .drive ? driveFolderId ?? "" : "",
      day: tab == .calendar ? calendarDay : nil)
  }
}

extension View {
  /// Opens what the create menu asked for, over whichever tab is on show: the composer, the
  /// event or task editor, or Drive's flows. What was made reaches the lists that
  /// show it through `ChangeSignal`.
  func createFlows(_ request: Binding<CreateRequest?>) -> some View {
    modifier(CreateFlows(request: request))
  }
}

/// A new event's sheet, on its day.
private struct NewEvent: Identifiable {
  let id = UUID()
  let day: DayKey?
}

private struct CreateFlows: ViewModifier {
  @Binding var request: CreateRequest?
  @Environment(AppModel.self) private var app
  @State private var composing = false
  @State private var event: NewEvent?
  @State private var makingTask = false
  @State private var driveAdd: DriveAddRequest?

  func body(content: Content) -> some View {
    content
      .onChange(of: request) { _, request in
        guard let request else { return }
        self.request = nil
        start(request)
      }
      .sheet(isPresented: $composing) {
        // From the mailbox Mail shows: a shared group inbox sends as the group, as in the console.
        MailComposeView(source: .blank, box: app.box) { ChangeSignal.mail.bump() }
      }
      .sheet(item: $event) { event in
        CalendarEventEditor(event: nil, day: event.day) { _ in ChangeSignal.planner.bump() }
      }
      .sheet(isPresented: $makingTask) {
        TaskEditor(task: nil) { ChangeSignal.planner.bump() }
      }
      .driveAddFlows($driveAdd)
  }

  private func start(_ request: CreateRequest) {
    switch request.kind {
    case .message: composing = true
    case .event: event = NewEvent(day: request.day)
    case .task: makingTask = true
    case .folder: driveAdd = DriveAddRequest(kind: .folder, folderId: request.driveFolderId)
    case .photos: driveAdd = DriveAddRequest(kind: .photos, folderId: request.driveFolderId)
    case .files: driveAdd = DriveAddRequest(kind: .files, folderId: request.driveFolderId)
    }
  }
}
