# Workspace for iPhone

Your workspace in a native app on an iPhone and an iPad: Mail (with the shared group inboxes you are in), Drive, Calendar, Tasks and the Assistant over the [Workspace API](../docs/API.md). SwiftUI on iOS 26 with Liquid Glass, the system's type and the console's colours, and no third-party dependency. The Home Screen names it **Workspace**.

For Android, and for an iPhone on an older iOS, there is the web-view app in [`mobile/`](../mobile/README.md).

Two parts:

- `WorkspaceKit/`, a local Swift package: every shape in API.md as a `Codable` type, the sign-in, the Keychain store and `WorkspaceClient`, the actor that talks to the API. Nothing from UIKit, so it builds and tests on a Mac, and on Linux.
- `Workspace/`, the app: the sign-in screen, the tab bar, the create menu, the Assistant and account sheets, and one root view per feature.

[AGENTS.md](AGENTS.md) has the structure and the conventions for working on it.

## Signing in

Every deployment of Workspace has its own address, so the sign-in screen asks for three things: your **workspace's address** (the one you open it at in a browser, such as `workspace.example.com`), your address and your password. The app first checks that a workspace answers at that address (`/api/health`), so a typo never sends your password to another site, then signs in through the workspace's own sign-in (docs/API.md, Signing in). An account with an authenticator app is asked for its six-digit code next, or a backup code. The session's token is kept in the Keychain, and the address is remembered for the next sign-in. To use another workspace, sign out and enter its address.

- A release build signs in over HTTPS alone; a debug build also takes `http://` on `localhost` or a private network, for a workspace on your computer.
- A workspace with Duo turned on takes no sign-in on a password alone, and the app says so: Duo's prompt needs a browser. Use the workspace in a browser there for now.
- Signing out ends the session in the workspace too. A session ended in the workspace (Settings → Account → Sessions, "Sign out everywhere", a new password) signs the app out on its next request.

## Shared inboxes

When you are in a shared group inbox, Mail's title menu lists **Mailboxes**: your own and each shared inbox, with its unread count. Picking one shows its folders and labels; what you do there (read, archive, label, reply, a new message from the create menu) happens in that inbox, and a reply goes out from the group's address with your name kept on it for the other members. A distribution group's mail lands in your own inbox, and its address is among those you can send from.

## Develop

Xcode 27 or later with the iOS 26 SDK, and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). The Xcode project is generated from `project.yml` and committed; regenerate it after adding, moving or removing a file, and commit the result:

```sh
xcodegen generate
open RIVIWorkspace.xcodeproj
```

Run the **Workspace** scheme on a simulator or an iPhone. No signing team is set: a simulator build is signed ad hoc by Xcode, which is enough, and a device takes your team under Signing & Capabilities (do not commit it). From the command line:

```sh
xcodebuild -project RIVIWorkspace.xcodeproj -scheme Workspace \
  -destination 'platform=iOS Simulator,name=iPhone 17' -configuration Debug build
cd WorkspaceKit && swift build && swift test
```

The package's tests also run on Linux, in Swift's own image: `docker run --rm -v "$PWD:/pkg" -w /pkg swift:6.2 swift test` from `WorkspaceKit/`. They cover the decoding of every main shape, the address rules, the sign-in with its second step, the session's end on `401`, the shared inbox on every Mail call and the chat's event stream, all through a stub `URLProtocol`; nothing reaches the network.

A build with `CODE_SIGNING_ALLOWED=NO` (what CI does, since it installs nothing) compiles the same but must not be installed: an unsigned app has no `application-identifier` entitlement, so the Keychain refuses the session (`-34018`) and a sign-in ends in that error.

### A local workspace

Start the workspace (`pnpm run dev` in the repository's root; its README has the setup, and the seed's `admin@example.com` / `password` signs in), then enter `http://localhost:5174` as the workspace's address in a debug build. The simulator reaches your computer as `localhost`; a phone on the same Wi-Fi reaches it by the computer's address, with the workspace started with `pnpm exec vite dev --host`. To have the field filled in, turn on `WORKSPACE_URL` under the scheme's Run > Arguments in Xcode, or launch with `SIMCTL_CHILD_WORKSPACE_URL=http://localhost:5174 xcrun simctl launch booted software.rivi.workspace`.

## Notifications

Settings has a **Notifications** section: **Calendar events** with how long before they start, **Tasks due today**, and the time of the morning reminders (all-day events and the tasks due that day). They are reminders the phone schedules itself from the coming week's events (not the ones declined) and open tasks, planned again each time the app comes to the front. A tap opens the event, or Tasks. The app does not subscribe to push yet, so there is no notification of new mail: a workspace can send one through a push relay ([docs/PUSH.md](../docs/PUSH.md)), which the app will take once it registers its device and opens notices in a notification service extension.

## Releases

There is no published build. The version is `MARKETING_VERSION` in `project.yml`; the bundle identifier is `software.rivi.workspace`, which the web-view app's iPhone target in `mobile/` shares, so a phone holds one or the other.
