# Workspace for iPhone and Android

Your workspace in an app of its own on a phone: its icon on the Home Screen, the page under the status bar and above the home indicator with nothing of a browser around it, links to other sites in the phone's browser, a file downloaded on an iPhone in the Files app and on Android in the Downloads folder, its own page with Try again when the workspace cannot be reached, and the Android back button going back through the workspace. It is a [Tauri 2](https://v2.tauri.app) shell around the system's own web view (WebKit on an iPhone, the Android System WebView) that opens the workspace you name: every deployment of Workspace has an address of its own, and the app bundles no copy of it, so it always shows what your Worker serves.

The workspace itself does the rest of the work of feeling native, in the app and as a web app added to the Home Screen from Safari or Chrome: its web app manifest and Home Screen icons, the safe areas it keeps clear, the status bar in its theme's colour, and the tab bar at the bottom of a phone screen.

- **iPhone**: iOS 16.4 or later, the oldest WebKit the workspace's stylesheet runs on.
- **Android**: Android 7 or later with an Android System WebView from 2023 or later (Chrome 111), which Google Play updates on its own.

## Your workspace's address

The first time it opens, the app asks for your workspace's address: the one you sign in to in a browser, such as `workspace.example.com` (the app adds `https://` and drops anything after the host). Before it keeps the address, it checks that a workspace answers there (`/api/health`, which every workspace lets any origin read), so a typo never leaves the app on some other site. The app remembers the address and opens it on every launch.

To switch to another workspace, sign out and tap **Use another workspace** under the sign-in form (the link shows only in the app), or tap it on the page the app shows when it cannot reach your workspace.

A release build opens a workspace over HTTPS alone. A debug build also takes `http://` on `localhost` or a private network address, for a workspace on your own computer.

### Building the app for your own deployment

A deployment that builds the app for its own people can name its address in the build, so the app opens it without asking: set `plugins.workspace.url` in `src-tauri/tauri.conf.json`:

```json
"plugins": { "workspace": { "url": "https://workspace.example.com/" } }
```

People can still name another workspace from the sign-in page; what they name wins over the build's. To ship it under your own name, change `productName` and `identifier` there (and run `tauri ios init` and `tauri android init` again, since the Xcode and Android projects carry the identifier), and the icon in `icon/icon.svg` (`pnpm run icons`).

## Develop

You need the repository's Node.js and pnpm, [rustup](https://rustup.rs), which installs the Rust version and the iPhone and Android targets in `src-tauri/rust-toolchain.toml` on the first build, and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/): for the iPhone, a Mac with Xcode and the iOS platform; for Android, Android Studio with the SDK, the NDK and its Java runtime, named to the shell as `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/<version>"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
```

Every development script names the local workspace in the build, so start it first, from the repository's root:

```sh
pnpm run dev                     # the workspace on http://localhost:5174, in another terminal
cd mobile
pnpm run app:dev                 # the app as a phone-sized window on this computer
pnpm run ios:dev                 # the app in the iOS Simulator (or on an iPhone over USB)
pnpm run android:dev             # the app in an Android emulator (or on a phone over USB)
```

`app:dev` is the quickest look at the shell: the same app in a desktop window. The iOS Simulator reaches the computer as `localhost`; an Android emulator reaches it as `10.0.2.2`, which `android:dev` builds in, and which is the computer's IPv4 loopback: Vite listens on `::1` alone by default, so start the workspace with `pnpm exec vite dev --host 127.0.0.1` for the emulator. On Android 16 or later the emulator keeps that local address behind a permission the debug build declares: `adb shell pm grant software.rivi.workspace android.permission.ACCESS_LOCAL_NETWORK` once the app is installed. A phone over USB reaches the computer by its Wi-Fi address: start the workspace with `pnpm exec vite dev --host`, and either type `http://<the computer's address>:5174` on the start page of a debug build, or build with it, `pnpm exec tauri ios dev --config '{"plugins":{"workspace":{"url":"http://<address>:5174"}}}'` (or `android dev`).

An address you typed on the start page wins over the one a script builds in, and the app keeps it across builds; tap **Use another workspace** to go back to the local one.

`pnpm run verify` runs the TypeScript, lint and Vitest checks of the scripts and the start page, then `pnpm run rust:check` (rustfmt, Clippy and the Rust tests). `pnpm run ios:build` and `pnpm run android:build` make a release build: the iPhone's needs an Apple Developer team (`APPLE_DEVELOPMENT_TEAM`) and a signing identity, Android's a signing key. `pnpm run icons` writes the app's icons into the Xcode and Android projects and the workspace's Home Screen icons into `../public/` from `icon/icon.svg`.

To see the app on a phone without a release, open the project in Xcode (`pnpm exec tauri ios dev --open`) or Android Studio (`pnpm exec tauri android dev --open`) and run it on the connected phone from there; keep the Tauri command running while the IDE is open, as it builds the Rust part.

## Releases

There is no published build. `.github/workflows/mobile.yml` checks the shell on every pull request that changes it and leaves an unsigned Android debug package (`apk-test`) for three days. Signing, TestFlight and the Play Console are for whoever ships the app to their people: `version` in `package.json` is the app's version. [AGENTS.md](AGENTS.md) has the rules for working on the app.
