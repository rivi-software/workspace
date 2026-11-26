import SwiftUI
import WorkspaceKit

/// Where a tap goes: a stored conversation, or a new one, with its first question or without.
struct AssistantRoute: Hashable {
  var conversationId: String?
  var opening: String?
}

/// The conversations, newest first, with the opening questions when there are none yet.
@Observable @MainActor
final class AssistantModel {
  var conversations: LoadState<ConversationList> = .idle
  /// What the last delete said went wrong.
  var deleteError: String?

  func load(_ client: WorkspaceClient) async {
    conversations.begin()
    do {
      conversations.finish(try await client.conversations())
    } catch {
      conversations.fail(error)
    }
  }

  /// Takes the conversation out of the list at once and tells the server; a refusal puts it
  /// back with the server's words.
  func delete(_ client: WorkspaceClient, id: String) async {
    guard var list = conversations.value,
      let index = list.conversations.firstIndex(where: { $0.id == id })
    else { return }
    let removed = list.conversations.remove(at: index)
    conversations.finish(list)
    deleteError = nil
    do {
      _ = try await client.deleteConversation(id: id)
    } catch {
      guard let message = failureMessage(error) else { return }
      deleteError = message
      var current = conversations.value ?? list
      current.conversations.insert(removed, at: min(index, current.conversations.count))
      conversations.finish(current)
    }
  }
}

/// The Assistant in its sheet, opened from the top leading button of every tab (`tabToolbar`):
/// the conversations, a new one from the floating button, and the close button.
struct AssistantRootView: View {
  @Environment(\.workspaceClient) private var client
  @Environment(\.dismiss) private var dismiss
  @State private var model = AssistantModel()
  @State private var route: AssistantRoute?
  @State private var pendingDelete: ConversationRef?
  @State private var confirmingDelete = false

  var body: some View {
    LoadStateView(state: model.conversations, retry: { await model.load(client) }) { list in
      VStack(spacing: 0) {
        if let error = model.deleteError {
          ErrorBanner(message: error)
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
        if list.conversations.isEmpty {
          empty(suggestions: list.suggestions)
        } else {
          conversations(list.conversations)
        }
      }
    }
    .floatingAction {
      GlassIconButton(systemImage: "plus.bubble", label: "New conversation", prominent: true) {
        route = AssistantRoute()
      }
    }
    .navigationTitle("Assistant")
    .navigationDestination(item: $route) { route in
      AssistantChatView(conversationId: route.conversationId, opening: route.opening)
    }
    .navigationDestination(for: AssistantRoute.self) { route in
      AssistantChatView(conversationId: route.conversationId, opening: route.opening)
    }
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button(role: .close) { dismiss() }
      }
    }
    .task { await model.load(client) }
    .refreshable { await model.load(client) }
    .onAppear {
      // Back from a chat: the list's titles and times moved on. The first load is `.task`'s.
      guard model.conversations.value != nil else { return }
      Task { await model.load(client) }
    }
    .confirmationDialog(
      "Delete this conversation?", isPresented: $confirmingDelete, titleVisibility: .visible,
      presenting: pendingDelete
    ) { conversation in
      Button("Delete", role: .destructive) {
        Task { await model.delete(client, id: conversation.id) }
      }
    } message: { conversation in
      Text(conversation.title)
    }
  }

  private func conversations(_ conversations: [ConversationRef]) -> some View {
    List {
      ForEach(conversations) { conversation in
        NavigationLink(value: AssistantRoute(conversationId: conversation.id)) {
          VStack(alignment: .leading, spacing: 3) {
            Text(conversation.title)
              .font(.body.weight(.medium))
              .lineLimit(2)
            RelativeDateText(date: conversation.updatedAt)
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          .padding(.vertical, 2)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          Button("Delete", systemImage: "trash", role: .destructive) {
            pendingDelete = conversation
            confirmingDelete = true
          }
        }
      }
    }
    .listStyle(.plain)
    .contentMargins(.bottom, 88, for: .scrollContent)
  }

  private func empty(suggestions: [String]) -> some View {
    ScrollView {
      VStack(spacing: 28) {
        AssistantIntro(alignment: .center)
          .padding(.horizontal, 32)
        if !suggestions.isEmpty {
          AssistantSuggestionChips(suggestions: suggestions, alignment: .center) { suggestion in
            route = AssistantRoute(opening: suggestion)
          }
          .padding(.horizontal, 24)
        }
      }
      .padding(.bottom, 96)
      .containerRelativeFrame(.vertical, alignment: .center)
    }
  }
}
