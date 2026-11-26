import SwiftUI
import WorkspaceKit

@main
struct WorkspaceApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .environment(\.workspaceClient, model.client)
        .task {
          delegate.connect(model.notifications)
          await model.start()
        }
        .onChange(of: scenePhase) { _, phase in
          guard phase == .active, model.me != nil else { return }
          Task {
            await model.reloadMe()
            await model.notifications.cameForward()
          }
        }
    }
  }
}
