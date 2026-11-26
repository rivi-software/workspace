import SwiftUI
import WorkspaceKit

/// The account sheet: who is signed in, on which workspace, the notifications, where the rest of
/// the settings live, the app's version, and sign out.
struct SettingsView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.workspaceClient) private var client
  @Environment(\.openURL) private var openURL
  @Environment(\.dismiss) private var dismiss
  @State private var confirmingSignOut = false
  @State private var signingOut = false

  var body: some View {
    NavigationStack {
      List {
        if let me = app.me {
          header(me)
        }
        workspace
        NotificationSettingsSection()
        connections
        about
        signOut
      }
      .navigationTitle("Settings")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      .confirmationDialog(
        "Sign out of RIVI Workspace?", isPresented: $confirmingSignOut, titleVisibility: .visible
      ) {
        Button("Sign out", role: .destructive) {
          Task { await performSignOut() }
        }
      } message: {
        Text("Your mail and files stay in the workspace. Sign in again any time.")
      }
    }
  }

  private func header(_ me: Me) -> some View {
    Section {
      VStack(spacing: 8) {
        AvatarView(name: me.user.name, size: 72)
        Text(me.user.name)
          .font(.title3.weight(.semibold))
          .multilineTextAlignment(.center)
        Text(me.user.email)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .multilineTextAlignment(.center)
        Text(roleName(me.user.role))
          .font(.caption.weight(.semibold))
          .foregroundStyle(Theme.accent)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(Theme.accentSoft, in: .capsule)
          .padding(.top, 2)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 8)
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .accessibilityElement(children: .combine)
    }
  }

  private var workspace: some View {
    Section("Workspace") {
      LabeledContent("Workspace", value: app.me?.appName ?? app.host)
      LabeledContent("Address", value: app.host)
    }
  }

  private var connections: some View {
    Section {
      Button("Open the workspace", systemImage: "arrow.up.right.square") {
        openURL(client.server)
      }
    } header: {
      Text("Connections")
    } footer: {
      Text("Passkeys, sessions and mail settings are in the workspace's Settings. To use another workspace, sign out and enter its address.")
    }
  }

  private var about: some View {
    Section("About") {
      LabeledContent("App", value: "RIVI Workspace for iPhone")
      LabeledContent("Version", value: "\(Self.version) (\(Self.build))")
    }
  }

  private var signOut: some View {
    Section {
      Button(role: .destructive) {
        confirmingSignOut = true
      } label: {
        HStack(spacing: 8) {
          if signingOut {
            ProgressView()
          }
          Text(signingOut ? "Signing out" : "Sign out")
        }
        .frame(maxWidth: .infinity)
      }
      .disabled(signingOut)
    }
  }

  private func performSignOut() async {
    signingOut = true
    await app.signOut()
    signingOut = false
    dismiss()
  }

  private func roleName(_ role: Role) -> String {
    switch role {
    case .admin: "Admin"
    case .member: "Member"
    case .other(let raw): raw.capitalized
    }
  }

  private static var version: String {
    Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
  }

  private static var build: String {
    Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
  }
}
