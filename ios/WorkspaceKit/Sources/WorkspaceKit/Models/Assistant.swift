import Foundation

public struct ConversationRef: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var updatedAt: Date
}

/// `GET /assistant/conversations`, newest first, with the opening questions.
public struct ConversationList: Codable, Hashable, Sendable {
  public var conversations: [ConversationRef]
  public var suggestions: [String]
}

public enum MessageRole: WireEnum {
  case user, assistant
  case other(String)

  public static let known: [String: Self] = ["user": .user, "assistant": .assistant]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

/// The Assistant's tools, with the line a client shows for a step of each.
public enum AssistantTool: WireEnum {
  case searchMail, readConversation, searchDrive, readFile, createDraft
  case other(String)

  public static let known: [String: Self] = [
    "search_mail": .searchMail, "read_conversation": .readConversation,
    "search_drive": .searchDrive, "read_file": .readFile, "create_draft": .createDraft,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }

  public var stepLabel: String {
    switch self {
    case .searchMail: "Searched mail"
    case .readConversation: "Read a conversation"
    case .searchDrive: "Searched Drive"
    case .readFile: "Read a file"
    case .createDraft: "Prepared a draft"
    case .other: "Worked on it"
    }
  }
}

/// A tool's step in a stored message.
public struct ToolStep: Hashable, Sendable {
  public var tool: AssistantTool
  public var toolCallId: String
  public var state: String
  public var input: JSONValue?
  public var output: JSONValue?

  public init(
    tool: AssistantTool, toolCallId: String, state: String, input: JSONValue?, output: JSONValue?
  ) {
    self.tool = tool
    self.toolCallId = toolCallId
    self.state = state
    self.input = input
    self.output = output
  }
}

/// A part of a stored message: text (Markdown, with links on console paths), a step boundary, a
/// tool's step, or something newer than this app.
public enum Part: Hashable, Sendable, Codable {
  case text(String)
  case stepStart
  case tool(ToolStep)
  case other(type: String)

  enum CodingKeys: String, CodingKey { case type, text, toolCallId, state, input, output }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let type = try container.decode(String.self, forKey: .type)
    switch type {
    case "text":
      self = .text(try container.decode(String.self, forKey: .text))
    case "step-start":
      self = .stepStart
    default:
      guard type.hasPrefix("tool-") else {
        self = .other(type: type)
        return
      }
      let name = String(type.dropFirst("tool-".count))
      self = .tool(
        ToolStep(
          tool: AssistantTool(rawValue: name),
          toolCallId: try container.decodeIfPresent(String.self, forKey: .toolCallId) ?? "",
          state: try container.decodeIfPresent(String.self, forKey: .state) ?? "",
          input: try container.decodeIfPresent(JSONValue.self, forKey: .input),
          output: try container.decodeIfPresent(JSONValue.self, forKey: .output)))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .text(let text):
      try container.encode("text", forKey: .type)
      try container.encode(text, forKey: .text)
    case .stepStart:
      try container.encode("step-start", forKey: .type)
    case .tool(let step):
      try container.encode("tool-\(step.tool.rawValue)", forKey: .type)
      try container.encode(step.toolCallId, forKey: .toolCallId)
      try container.encode(step.state, forKey: .state)
      try container.encodeIfPresent(step.input, forKey: .input)
      try container.encodeIfPresent(step.output, forKey: .output)
    case .other(let type):
      try container.encode(type, forKey: .type)
    }
  }
}

public struct StoredMessage: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var role: MessageRole
  public var parts: [Part]

  public init(id: String, role: MessageRole, parts: [Part]) {
    self.id = id
    self.role = role
    self.parts = parts
  }

  /// The text parts joined, for a list's preview.
  public var text: String {
    parts.compactMap {
      if case .text(let text) = $0 { return text }
      return nil
    }.joined()
  }
}

/// `GET /assistant/conversations/:id`, oldest message first.
public struct ConversationDetail: Codable, Hashable, Sendable {
  public var conversation: ConversationRef
  public var messages: [StoredMessage]
}

/// `POST /assistant/chat`: `conversationId` is written as `null` to start a new conversation.
public struct ChatRequest: Encodable, Hashable, Sendable {
  public var conversationId: String?
  public var text: String

  public init(conversationId: String?, text: String) {
    self.conversationId = conversationId
    self.text = text
  }

  enum CodingKeys: String, CodingKey { case conversationId, message }
  enum MessageKeys: String, CodingKey { case role, parts }
  enum PartKeys: String, CodingKey { case type, text }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(conversationId, forKey: .conversationId)
    var message = container.nestedContainer(keyedBy: MessageKeys.self, forKey: .message)
    try message.encode("user", forKey: .role)
    var parts = message.nestedUnkeyedContainer(forKey: .parts)
    var part = parts.nestedContainer(keyedBy: PartKeys.self)
    try part.encode("text", forKey: .type)
    try part.encode(text, forKey: .text)
  }
}
