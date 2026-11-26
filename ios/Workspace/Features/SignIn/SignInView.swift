import SwiftUI
import WorkspaceKit

/// The sign-in's steps: the workspace's address, the person's address and password, then the
/// authenticator's code where the account has one. The address is checked before the password
/// leaves the phone (`/api/health` answers as a workspace), so a typo never sends it elsewhere.
@Observable @MainActor
final class SignInModel {
  var address: String
  var email = ""
  var password = ""
  var code = ""
  var factor: SecondFactor = .authenticator
  /// The workspace's name once its address was checked.
  private(set) var workspaceName: String?
  /// Waiting for the second step.
  private(set) var challenge: SecondFactorChallenge?
  private(set) var busy = false
  private(set) var error: String?

  private var authenticator: Authenticator?

  init(address: String = Server.suggestion()) {
    self.address = address
  }

  var canSubmit: Bool {
    if busy { return false }
    if challenge != nil { return !code.trimmingCharacters(in: .whitespaces).isEmpty }
    return !address.isEmpty && !email.isEmpty && !password.isEmpty
  }

  /// The first step: the address checked, then the password.
  func signIn(_ app: AppModel) async {
    guard canSubmit, challenge == nil else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let server = try WorkspaceAddress.parse(address, allowsLocalHTTP: Server.allowsLocalHTTP)
      let authenticator = Authenticator(server: server)
      let info = try await reach(host: server.host() ?? address) {
        try await authenticator.checkWorkspace()
      }
      workspaceName = info.app
      self.authenticator = authenticator
      switch try await authenticator.signIn(email: email, password: password) {
      case .signedIn(let credentials):
        try await finish(app, credentials)
      case .secondFactor(let challenge):
        self.challenge = challenge
      }
    } catch {
      self.error = Self.words(for: error)
    }
  }

  /// The second step: the code, then the same finish.
  func verify(_ app: AppModel) async {
    guard canSubmit, let challenge, let authenticator else { return }
    busy = true
    error = nil
    defer { busy = false }
    do {
      let credentials = try await authenticator.verify(challenge, code: code, with: factor)
      try await finish(app, credentials)
    } catch {
      self.error = Self.words(for: error)
    }
  }

  /// Back from the code to the password, as from a fresh start.
  func startOver() {
    challenge = nil
    code = ""
    error = nil
  }

  private func finish(_ app: AppModel, _ credentials: Credentials) async throws {
    password = ""
    code = ""
    try await app.signedIn(credentials)
  }

  /// A check that cannot reach the address says so in the person's words, not the transport's.
  private func reach<T: Sendable>(host: String, _ step: () async throws -> T) async throws -> T {
    do {
      return try await step()
    } catch let error as URLError where error.code != .cancelled {
      throw SignInProblem("Couldn’t reach \(host). Check the address and your connection.")
    }
  }

  private static func words(for error: any Error) -> String? {
    if error is CancellationError { return nil }
    if let error = error as? URLError, error.code == .cancelled { return nil }
    return error.localizedDescription
  }
}

struct SignInProblem: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

/// The whole screen before sign-in: Workspace's symbol, the name, and the form. The symbol's tiles
/// come in one by one and the first lights; while a step is on its way, the lit tile walks round
/// the four.
struct SignInView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme
  @State private var model = SignInModel()
  /// The entrance: how many tiles show, and whether the first is lit yet.
  @State private var shownTiles = 0
  @State private var lit = false
  @FocusState private var focus: Field?

  private enum Field: Hashable {
    case address, email, password, code
  }

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(spacing: 0) {
          Spacer(minLength: 40)
          symbol
          Text(model.workspaceName ?? "Workspace")
            .font(.largeTitle.weight(.bold))
            .multilineTextAlignment(.center)
            .padding(.top, 28)
          Text(subtitle)
            .font(.body)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 8)
            .padding(.horizontal, 32)
          Spacer(minLength: 32)
          form
        }
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
      }
      .scrollBounceBehavior(.basedOnSize)
      .scrollDismissesKeyboard(.interactively)
    }
    .background(Theme.canvas.ignoresSafeArea())
    .task { await enter() }
    .onAppear { focus = model.address.isEmpty ? .address : .email }
  }

  private var subtitle: String {
    model.challenge == nil
      ? "Sign in with the address of your workspace and your own."
      : "Enter the code from your authenticator app."
  }

  @ViewBuilder private var symbol: some View {
    Group {
      if model.busy {
        WorkspaceLoader(size: 88, tiled: true)
      } else {
        WorkspaceSymbol(size: 88, lit: lit ? 0 : nil, shown: shownTiles)
      }
    }
    .shadow(color: .black.opacity(colorScheme == .dark ? 0 : 0.14), radius: 18, y: 10)
    .accessibilityHidden(true)
  }

  /// The tiles one by one, then the light; all at once with Reduce Motion on.
  private func enter() async {
    guard shownTiles < 4 else { return }
    guard !reduceMotion else {
      shownTiles = 4
      lit = true
      return
    }
    for tile in 1...4 {
      try? await Task.sleep(for: .milliseconds(tile == 1 ? 120 : 70))
      withAnimation(.spring(duration: 0.45, bounce: 0.35)) { shownTiles = tile }
    }
    try? await Task.sleep(for: .milliseconds(220))
    withAnimation(.easeOut(duration: 0.4)) { lit = true }
  }

  private var form: some View {
    VStack(spacing: 14) {
      if model.challenge == nil {
        credentialFields
      } else {
        codeFields
      }
      if let error = model.error {
        ErrorBanner(message: error)
      }
      Button {
        Task { await submit() }
      } label: {
        HStack(spacing: 8) {
          if model.busy {
            ProgressView()
              .tint(Theme.onAccent)
          }
          Text(model.busy ? "Signing in" : model.challenge == nil ? "Sign in" : "Confirm")
            .fontWeight(.semibold)
        }
        .foregroundStyle(Theme.onAccent)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
      }
      .prominentAction()
      .controlSize(.large)
      .disabled(!model.canSubmit)
      if model.challenge != nil {
        Button("Use another account") { model.startOver() }
          .font(.subheadline)
          .disabled(model.busy)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 24)
  }

  @ViewBuilder private var credentialFields: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 6) {
      field("Workspace address") {
        TextField("workspace.example.com", text: $model.address)
          .keyboardType(.URL)
          .textContentType(.URL)
          .focused($focus, equals: .address)
          .submitLabel(.next)
          .onSubmit { focus = .email }
      }
      Text("The address you open your workspace at in a browser.")
        .font(.caption)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 4)
    }
    field("Email") {
      TextField("you@example.com", text: $model.email)
        .keyboardType(.emailAddress)
        .textContentType(.username)
        .focused($focus, equals: .email)
        .submitLabel(.next)
        .onSubmit { focus = .password }
    }
    field("Password") {
      SecureField("Password", text: $model.password)
        .textContentType(.password)
        .focused($focus, equals: .password)
        .submitLabel(.go)
        .onSubmit { Task { await submit() } }
    }
  }

  @ViewBuilder private var codeFields: some View {
    @Bindable var model = model
    Picker("Code from", selection: $model.factor) {
      Text("Authenticator").tag(SecondFactor.authenticator)
      Text("Backup code").tag(SecondFactor.backupCode)
    }
    .pickerStyle(.segmented)
    field(model.factor == .authenticator ? "Six-digit code" : "Backup code") {
      TextField(model.factor == .authenticator ? "123456" : "Backup code", text: $model.code)
        .keyboardType(model.factor == .authenticator ? .numberPad : .asciiCapable)
        .textContentType(.oneTimeCode)
        .focused($focus, equals: .code)
        .submitLabel(.go)
        .onSubmit { Task { await submit() } }
        .onAppear { focus = .code }
    }
  }

  private func field(_ label: String, @ViewBuilder input: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label)
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 4)
      input()
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Theme.elevated, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.border))
    }
  }

  private func submit() async {
    focus = nil
    if model.challenge == nil {
      await model.signIn(app)
    } else {
      await model.verify(app)
    }
  }
}
