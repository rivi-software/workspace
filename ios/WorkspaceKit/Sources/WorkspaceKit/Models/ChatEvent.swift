import Foundation

/// One event of the chat's stream (the AI SDK's UI message stream over server-sent events).
public enum ChatEvent: Hashable, Sendable {
  /// The answer's message and the conversation it belongs to (a new one's id when the request
  /// named none).
  case start(messageId: String?, conversationId: String?)
  case textStart(id: String)
  case textDelta(id: String, delta: String)
  case textEnd(id: String)
  case toolInputStart(callId: String, name: String)
  case toolInputAvailable(callId: String, name: String, input: JSONValue)
  case toolOutputAvailable(callId: String, output: JSONValue)
  case startStep
  case finishStep
  case finish
  case error(String)
  /// An event type this app does not know; the stream goes on.
  case unknown(type: String)

  /// Reads one `data:` payload, a JSON object.
  public init(json data: Data) throws {
    let raw = try JSONDecoder().decode(RawChatEvent.self, from: data)
    switch raw.type {
    case "start":
      self = .start(
        messageId: raw.messageId,
        conversationId: raw.messageMetadata?["conversationId"]?.stringValue)
    case "text-start":
      self = .textStart(id: raw.id ?? "")
    case "text-delta":
      self = .textDelta(id: raw.id ?? "", delta: raw.delta ?? "")
    case "text-end":
      self = .textEnd(id: raw.id ?? "")
    case "tool-input-start":
      self = .toolInputStart(callId: raw.toolCallId ?? "", name: raw.toolName ?? "")
    case "tool-input-available":
      self = .toolInputAvailable(
        callId: raw.toolCallId ?? "", name: raw.toolName ?? "", input: raw.input ?? .null)
    case "tool-output-available":
      self = .toolOutputAvailable(callId: raw.toolCallId ?? "", output: raw.output ?? .null)
    case "start-step":
      self = .startStep
    case "finish-step":
      self = .finishStep
    case "finish":
      self = .finish
    case "error":
      self = .error(raw.errorText ?? "The assistant could not answer.")
    default:
      self = .unknown(type: raw.type)
    }
  }
}

struct RawChatEvent: Decodable {
  var type: String
  var messageId: String?
  var messageMetadata: JSONValue?
  var id: String?
  var delta: String?
  var toolCallId: String?
  var toolName: String?
  var input: JSONValue?
  var output: JSONValue?
  var errorText: String?
}
