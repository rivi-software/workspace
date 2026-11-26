// swift-tools-version: 6.0
import PackageDescription

// WorkspaceKit: the Workspace API's shapes, sign-in and client, with nothing from UIKit, so it
// builds and tests on macOS (`swift build`, `swift test`) as well as inside the app.
let package = Package(
  name: "WorkspaceKit",
  platforms: [.iOS("26.0"), .macOS("15.0")],
  products: [
    .library(name: "WorkspaceKit", targets: ["WorkspaceKit"])
  ],
  targets: [
    .target(
      name: "WorkspaceKit",
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
    .testTarget(
      name: "WorkspaceKitTests",
      dependencies: ["WorkspaceKit"],
      swiftSettings: [.swiftLanguageMode(.v6)]
    ),
  ]
)
