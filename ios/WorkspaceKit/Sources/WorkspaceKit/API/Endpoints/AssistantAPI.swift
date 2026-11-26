import Foundation

extension WorkspaceClient {
  /// `GET /assistant/conversations`, newest first.
  public func conversations() async throws -> ConversationList {
    try await get("/assistant/conversations")
  }

  /// `GET /assistant/conversations/:id`, oldest message first.
  public func conversation(id: String) async throws -> ConversationDetail {
    try await get("/assistant/conversations/\(pathComponent(id))")
  }

  /// `DELETE /assistant/conversations/:id`.
  public func deleteConversation(id: String) async throws -> OKResponse {
    try await delete("/assistant/conversations/\(pathComponent(id))")
  }

  /// `POST /assistant/chat`: the answer as it comes. `conversationId` nil starts a conversation;
  /// the stream's `start` event names it.
  public nonisolated func chat(conversationId: String?, text: String) -> AsyncThrowingStream<ChatEvent, any Error> {
    chatEvents(ChatRequest(conversationId: conversationId, text: text))
  }
}
