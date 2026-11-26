import Observation

/// Something changed that screens other than the one that changed it show: each of them reads
/// itself again when `version` moves. One signal per kind of data, since one screen's change can
/// show on several (the create menu makes what Mail, Calendar, Tasks and Drive list).
@Observable @MainActor
final class ChangeSignal {
  /// A message sent or a draft kept: Mail's lists.
  static let mail = ChangeSignal()
  /// An event or a task made: Calendar shows both, Tasks the tasks.
  static let planner = ChangeSignal()
  /// A rename, a move, a trash, a new folder or an upload: every Drive listing on screen, since
  /// the root and the folders on the navigation stack show one tree.
  static let drive = ChangeSignal()

  private(set) var version = 0

  func bump() {
    version += 1
  }
}
