import SwiftUI
import WorkspaceKit

/// One conversation: the transcript, the answer as it streams, and the question bar.
struct AssistantChatView: View {
  let conversationId: String?
  /// A first question to ask as soon as the screen is up (a suggestion tapped in the list).
  var opening: String?
  @Environment(\.workspaceClient) private var client
  @Environment(AppModel.self) private var app
  @State private var model: AssistantChatModel
  @State private var input = ""
  @State private var openingSent = false
  @State private var safariLink: AssistantSafariLink?
  @FocusState private var inputFocused: Bool

  init(conversationId: String?, opening: String? = nil) {
    self.conversationId = conversationId
    self.opening = opening
    _model = State(initialValue: AssistantChatModel(conversationId: conversationId))
  }

  var body: some View {
    LoadStateView(state: model.history, retry: { await model.load(client) }) { _ in
      transcript
    }
    .safeAreaBar(edge: .bottom) {
      composer
    }
    .navigationTitle(model.title)
    .navigationBarTitleDisplayMode(.inline)
    .task {
      await model.load(client)
      if let opening, !openingSent, model.isEmpty {
        openingSent = true
        model.send(client, text: opening)
      }
    }
    .onDisappear { model.stop() }
    .sheet(item: $safariLink) { link in
      AssistantSafariView(url: link.url)
        .ignoresSafeArea()
    }
    .environment(\.openURL, OpenURLAction { url in open(url) })
  }

  private var transcript: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 16) {
        if model.isEmpty {
          intro
        }
        ForEach(model.transcript) { entry in
          AssistantEntryView(entry: entry)
        }
        if let draft = model.draft {
          AssistantEntryView(entry: draft)
          if model.isThinking {
            AssistantThinkingDots()
          }
        }
        if let error = model.error {
          ErrorBanner(message: error)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
    }
    .defaultScrollAnchor(.bottom)
    .defaultScrollAnchor(.bottom, for: .sizeChanges)
    .scrollDismissesKeyboard(.interactively)
  }

  /// A new conversation before its first question: what to ask, and the opening questions.
  private var intro: some View {
    VStack(alignment: .leading, spacing: 16) {
      AssistantIntro()
      let suggestions = app.me?.suggestions ?? []
      if !suggestions.isEmpty {
        AssistantSuggestionChips(suggestions: suggestions) { suggestion in
          model.send(client, text: suggestion)
        }
        .padding(.top, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.bottom, 24)
  }

  private var composer: some View {
    GlassGroup {
      HStack(alignment: .bottom, spacing: 10) {
        TextField("Ask about your mail and files", text: $input, axis: .vertical)
          .lineLimit(1...6)
          .focused($inputFocused)
          .padding(.horizontal, 16)
          .padding(.vertical, 11)
          .glassEffect(.regular, in: .rect(cornerRadius: 22))
        if model.isStreaming {
          Button {
            model.stop()
          } label: {
            Image(systemName: "stop.fill")
              .font(.body.weight(.semibold))
              .frame(width: 44, height: 44)
          }
          .prominentAction()
          .buttonBorderShape(.circle)
          .accessibilityLabel("Stop the answer")
        } else {
          Button {
            send()
          } label: {
            Image(systemName: "arrow.up")
              .font(.body.weight(.semibold))
              .frame(width: 44, height: 44)
          }
          .prominentAction()
          .buttonBorderShape(.circle)
          .disabled(trimmedInput.isEmpty || !model.canSend)
          .accessibilityLabel("Send")
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
  }

  private var trimmedInput: String {
    input.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func send() {
    let text = trimmedInput
    guard !text.isEmpty else { return }
    input = ""
    model.send(client, text: text)
  }

  /// A console link opens the workspace in Safari's view; any other link goes to the system.
  private func open(_ url: URL) -> OpenURLAction.Result {
    guard let page = AssistantLinks.consoleURL(url, server: client.server) else { return .systemAction }
    safariLink = AssistantSafariLink(url: page)
    return .handled
  }
}
