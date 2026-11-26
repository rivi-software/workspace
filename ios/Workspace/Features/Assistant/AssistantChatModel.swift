import Foundation
import Observation
import WorkspaceKit

/// One tool's step in an answer: running until its output arrives.
struct AssistantStep: Identifiable, Hashable {
  let id: String
  var tool: AssistantTool
  var input: JSONValue?
  var running: Bool

  /// One line of the input: its query, id or name, when it has one.
  var summary: String? {
    for key in ["query", "id", "name"] {
      if let value = input?[key]?.stringValue, !value.isEmpty { return value }
    }
    return nil
  }
}

/// A piece of a message as the chat shows it: a run of text, or a tool's step.
enum AssistantBlock: Identifiable, Hashable {
  case text(id: String, text: String)
  case step(AssistantStep)

  var id: String {
    switch self {
    case .text(let id, _): id
    case .step(let step): step.id
    }
  }
}

/// A message in the transcript: stored, sent from here, or the answer on its way.
struct AssistantEntry: Identifiable, Hashable {
  let id: String
  let role: MessageRole
  var blocks: [AssistantBlock]

  init(id: String, role: MessageRole, blocks: [AssistantBlock]) {
    self.id = id
    self.role = role
    self.blocks = blocks
  }

  /// A stored message's parts; step boundaries and parts newer than this app are left out.
  init(stored message: StoredMessage) {
    id = message.id
    role = message.role
    var blocks: [AssistantBlock] = []
    for (index, part) in message.parts.enumerated() {
      switch part {
      case .text(let text):
        blocks.append(.text(id: "\(message.id)-\(index)", text: text))
      case .tool(let step):
        let id = step.toolCallId.isEmpty ? "\(message.id)-\(index)" : step.toolCallId
        blocks.append(.step(AssistantStep(id: id, tool: step.tool, input: step.input, running: false)))
      case .stepStart, .other:
        break
      }
    }
    self.blocks = blocks
  }

  /// The text runs joined, for the person's bubble.
  var text: String {
    blocks.compactMap { block -> String? in
      if case .text(_, let text) = block { return text }
      return nil
    }.joined()
  }

  var hasText: Bool {
    blocks.contains { block in
      if case .text(_, let text) = block { return !text.isEmpty }
      return false
    }
  }
}

/// One conversation: its stored messages, what was sent here, and the answer as it streams.
@Observable @MainActor
final class AssistantChatModel {
  private(set) var conversationId: String?
  private(set) var title: String
  /// The stored messages on their way; a new conversation has none and is loaded at once.
  private(set) var history: LoadState<[AssistantEntry]>
  /// The messages as shown: the history, then what was sent and answered here.
  private(set) var transcript: [AssistantEntry] = []
  /// The answer on its way, nil between answers.
  private(set) var draft: AssistantEntry?
  /// What the stream said went wrong.
  private(set) var error: String?
  private var stream: Task<Void, Never>?

  init(conversationId: String?) {
    self.conversationId = conversationId
    title = conversationId == nil ? "New conversation" : "Conversation"
    history = conversationId == nil ? .loaded([]) : .idle
  }

  var isStreaming: Bool { draft != nil }

  var isEmpty: Bool { transcript.isEmpty && draft == nil }

  /// Dots until the answer's first words.
  var isThinking: Bool { isStreaming && !(draft?.hasText ?? false) }

  /// A question can go once the history is here and no answer is on its way.
  var canSend: Bool { history.value != nil && !isStreaming }

  func load(_ client: WorkspaceClient) async {
    guard let conversationId else { return }
    history.begin()
    do {
      let detail = try await client.conversation(id: conversationId)
      let entries = detail.messages.map(AssistantEntry.init(stored:))
      title = detail.conversation.title
      history.finish(entries)
      transcript = entries
    } catch {
      history.fail(error)
    }
  }

  /// Sends the question and reads the answer as it comes, in a task of its own so the view can
  /// stop it; the view cancels it when it goes away.
  func send(_ client: WorkspaceClient, text: String) {
    let question = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !question.isEmpty, canSend else { return }
    error = nil
    let stamp = UUID().uuidString
    transcript.append(
      AssistantEntry(id: "sent-\(stamp)", role: .user, blocks: [.text(id: "sent-\(stamp)-text", text: question)]))
    draft = AssistantEntry(id: "draft-\(stamp)", role: .assistant, blocks: [])
    let events = client.chat(conversationId: conversationId, text: question)
    stream = Task { await consume(events) }
  }

  /// Ends the answer where it is; what came stays in the transcript.
  func stop() {
    stream?.cancel()
  }

  private func consume(_ events: AsyncThrowingStream<ChatEvent, any Error>) async {
    do {
      for try await event in events {
        apply(event)
      }
    } catch {
      self.error = failureMessage(error)
    }
    settle()
  }

  private func settle() {
    if var finished = draft, !finished.blocks.isEmpty {
      finished.blocks = finished.blocks.map { block in
        guard case .step(var step) = block else { return block }
        step.running = false
        return .step(step)
      }
      transcript.append(finished)
    }
    draft = nil
    stream = nil
  }

  private func apply(_ event: ChatEvent) {
    switch event {
    case .start(_, let conversationId):
      if self.conversationId == nil, let conversationId { self.conversationId = conversationId }
    case .textStart(let id):
      appendText(id: id, "")
    case .textDelta(let id, let delta):
      appendText(id: id, delta)
    case .toolInputStart(let callId, let name):
      draft?.blocks.append(.step(AssistantStep(id: callId, tool: AssistantTool(rawValue: name), input: nil, running: true)))
    case .toolInputAvailable(let callId, let name, let input):
      if !updateStep(callId, { $0.input = input }) {
        draft?.blocks.append(
          .step(AssistantStep(id: callId, tool: AssistantTool(rawValue: name), input: input, running: true)))
      }
    case .toolOutputAvailable(let callId, _):
      _ = updateStep(callId) { $0.running = false }
    case .error(let message):
      error = message
    case .textEnd, .startStep, .finishStep, .finish, .unknown:
      break
    }
  }

  private func appendText(id: String, _ delta: String) {
    guard var blocks = draft?.blocks else { return }
    if let index = blocks.firstIndex(where: { $0.id == id }), case .text(_, let text) = blocks[index] {
      blocks[index] = .text(id: id, text: text + delta)
    } else {
      blocks.append(.text(id: id.isEmpty ? UUID().uuidString : id, text: delta))
    }
    draft?.blocks = blocks
  }

  /// Changes the step with that call id; false when the draft has none.
  private func updateStep(_ callId: String, _ change: (inout AssistantStep) -> Void) -> Bool {
    guard var blocks = draft?.blocks, let index = blocks.firstIndex(where: { $0.id == callId }),
      case .step(var step) = blocks[index]
    else { return false }
    change(&step)
    blocks[index] = .step(step)
    draft?.blocks = blocks
    return true
  }
}
