import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Reads server-sent events as the bytes come, in any chunking: each `data:` line is one JSON
/// event (the AI SDK sends one per line), `data: [DONE]` ends the stream, comments and other
/// fields are skipped, a line that is no event is counted in `dropped` and skipped, and
/// nothing after `[DONE]` is read.
public struct SSEParser: Sendable {
  private var line: [UInt8] = []
  public private(set) var isDone = false
  public private(set) var dropped = 0

  public init() {}

  /// Feeds a chunk; answers the events its complete lines held.
  public mutating func feed(_ bytes: some Sequence<UInt8>) -> [ChatEvent] {
    var events: [ChatEvent] = []
    for byte in bytes {
      if let event = feed(byte: byte) { events.append(event) }
    }
    return events
  }

  public mutating func feed(_ text: String) -> [ChatEvent] {
    feed(text.utf8)
  }

  /// Feeds one byte; answers an event when it completes a line that holds one.
  public mutating func feed(byte: UInt8) -> ChatEvent? {
    if isDone { return nil }
    guard byte == UInt8(ascii: "\n") else {
      line.append(byte)
      return nil
    }
    return flushLine()
  }

  /// The end of the bytes: a last line without its newline.
  public mutating func finish() -> ChatEvent? {
    line.isEmpty || isDone ? nil : flushLine()
  }

  private mutating func flushLine() -> ChatEvent? {
    defer { line.removeAll(keepingCapacity: true) }
    if line.last == UInt8(ascii: "\r") { line.removeLast() }
    guard !line.isEmpty, line.first != UInt8(ascii: ":") else { return nil }
    let prefix = Array("data:".utf8)
    guard line.count >= prefix.count, Array(line[0..<prefix.count]) == prefix else { return nil }
    var payload = line[prefix.count...]
    if payload.first == UInt8(ascii: " ") { payload = payload.dropFirst() }
    if Array(payload) == Array("[DONE]".utf8) {
      isDone = true
      return nil
    }
    do {
      return try ChatEvent(json: Data(payload))
    } catch {
      dropped += 1
      return nil
    }
  }
}

extension WorkspaceClient {
  /// `POST /assistant/chat` as a stream of events, ending at `data: [DONE]` or the end of the
  /// bytes. A problem before the stream starts (`400`, `404`) or a lost connection throws; a
  /// `401` signs out, as every request's does.
  public nonisolated func chatEvents(_ chat: ChatRequest) -> AsyncThrowingStream<ChatEvent, any Error> {
    AsyncThrowingStream { continuation in
      let task = Task {
        do {
          var request = try self.request(.post, "/assistant/chat", json: chat)
          request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
          let prepared = await self.prepare(request)
          #if canImport(FoundationNetworking)
            // Linux's Foundation has no `bytes(for:)`: the whole answer, read the same way. Only
            // `swift test` on Linux takes this path; the app streams.
            let (data, response) = try await self.session.data(for: prepared)
            let bytes = AsyncStream<UInt8> { stream in
              for byte in data { stream.yield(byte) }
              stream.finish()
            }
          #else
            let (bytes, response) = try await self.session.bytes(for: prepared)
          #endif
          guard let http = response as? HTTPURLResponse else { throw APIError.badResponse(status: 0) }
          if http.statusCode == 401 { throw await self.lose() }
          try await Self.read(bytes, http, into: continuation, problem: self.problem)
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  /// The answer's bytes as events; a failed answer's bytes as its problem.
  private static func read<Bytes: AsyncSequence>(
    _ bytes: Bytes, _ response: HTTPURLResponse,
    into continuation: AsyncThrowingStream<ChatEvent, any Error>.Continuation,
    problem: (Data, HTTPURLResponse) -> APIError
  ) async throws where Bytes.Element == UInt8 {
    guard (200..<300).contains(response.statusCode) else {
      var body = Data()
      for try await byte in bytes { body.append(byte) }
      throw problem(body, response)
    }
    var parser = SSEParser()
    for try await byte in bytes {
      if let event = parser.feed(byte: byte) { continuation.yield(event) }
      if parser.isDone { break }
    }
    if !parser.isDone, let last = parser.finish() { continuation.yield(last) }
    continuation.finish()
  }
}
