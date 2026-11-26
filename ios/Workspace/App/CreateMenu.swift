import SwiftUI

/// What the create menu makes.
enum CreateKind: Hashable, CaseIterable, Identifiable {
  case message, event, task, folder, photos, files

  var id: Self { self }

  var title: String {
    switch self {
    case .message: "New message"
    case .event: "New event"
    case .task: "New task"
    case .folder: "New folder"
    case .photos: "Upload a photo or video"
    case .files: "Upload a file"
    }
  }

  var systemImage: String {
    switch self {
    case .message: "square.and.pencil"
    case .event: "calendar.badge.plus"
    case .task: "checklist"
    case .folder: "folder.badge.plus"
    case .photos: "photo.on.rectangle"
    case .files: "doc.badge.plus"
    }
  }

  /// What a tap on the create menu makes on each tab; a press and hold offers the rest.
  static func primary(for tab: AppTab) -> CreateKind {
    switch tab {
    case .mail: .message
    case .drive: .files
    case .calendar: .event
    case .tasks: .task
    }
  }

  /// The menu's sections from the top down: the shown tab's, its primary first, then Mail's,
  /// Calendar and Tasks', and Drive's.
  static func sections(for tab: AppTab) -> [[CreateKind]] {
    let all: [[CreateKind]] = [[.message], [.event, .task], [.folder, .photos, .files]]
    let primary = primary(for: tab)
    let shown = all.firstIndex { $0.contains(primary) } ?? 0
    let first = [primary] + all[shown].filter { $0 != primary }
    return [first] + all.indices.filter { $0 != shown }.map { all[$0] }
  }
}

extension EnvironmentValues {
  /// The tab a screen is in, which the create menu makes things for; `MainTabView` sets it on
  /// each tab's stack.
  @Entry var appTab: AppTab = .mail
}

/// The create button at the top right of every tab, in the system's glass: a tap makes the shown
/// tab's thing (a message, an upload, an event, a task), and a press and hold opens the system's
/// menu of everything the workspace makes, the shown tab's first. `createFlows` opens what it asks
/// for (`CreateCenter`).
struct CreateMenu: View {
  @Environment(\.appTab) private var tab
  @Environment(CreateCenter.self) private var center: CreateCenter?

  var body: some View {
    let primary = CreateKind.primary(for: tab)
    Menu {
      ForEach(CreateKind.sections(for: tab), id: \.self) { section in
        Section {
          ForEach(section) { kind in
            Button(kind.title, systemImage: kind.systemImage) {
              center?.create(kind, from: tab)
            }
          }
        }
      }
    } label: {
      Label(primary.title, systemImage: primary == .message ? "square.and.pencil" : "plus")
    } primaryAction: {
      center?.create(primary, from: tab)
    }
    // The screen's primary action, so the one button in the bar in the accent.
    .tint(Theme.accent)
  }
}
