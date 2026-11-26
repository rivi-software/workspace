import Foundation
import Testing

@testable import WorkspaceKit

struct ChatStreamTests {
  private let expected: [ChatEvent] = [
    .start(messageId: "am_9", conversationId: "ac_7"),
    .startStep,
    .toolInputStart(callId: "call_1", name: "search_mail"),
    .toolInputAvailable(callId: "call_1", name: "search_mail", input: .object(["query": .string("invoice")])),
    .toolOutputAvailable(callId: "call_1", output: .object(["count": .number(3)])),
    .finishStep,
    .startStep,
    .textStart(id: "t1"),
    .textDelta(id: "t1", delta: "Three conversations "),
    .textDelta(id: "t1", delta: "mention an invoice."),
    .textEnd(id: "t1"),
    .finishStep,
    .finish,
  ]

  @Test func parsesTheSampleStream() {
    var parser = SSEParser()
    let events = parser.feed(Samples.chatStream)
    #expect(events == expected)
    #expect(parser.isDone)
    #expect(parser.dropped == 0)
  }

  @Test func chunksSplitMidLineAndMidUTF8() {
    var parser = SSEParser()
    var events: [ChatEvent] = []
    let bytes = Array(Samples.chatStream.utf8)
    for chunk in stride(from: 0, to: bytes.count, by: 7) {
      events += parser.feed(bytes[chunk..<min(chunk + 7, bytes.count)])
    }
    #expect(events == expected)
    #expect(parser.isDone)
    var umlaut = SSEParser()
    let line = Array(#"data: {"type":"text-delta","id":"t","delta":"Köln"}"#.utf8) + [10]
    var out: [ChatEvent] = []
    out += umlaut.feed(line[0..<36])
    out += umlaut.feed(line[36...])
    #expect(out == [.textDelta(id: "t", delta: "Köln")])
  }

  @Test func withoutBlankLinesCRLFAndWithoutDone() {
    var parser = SSEParser()
    let text = "data: {\"type\":\"start-step\"}\r\ndata: {\"type\":\"finish\"}"
    var events = parser.feed(text)
    #expect(events == [.startStep])
    if let last = parser.finish() { events.append(last) }
    #expect(events == [.startStep, .finish])
    #expect(!parser.isDone)
  }

  @Test func unknownErrorAndBrokenLines() {
    var parser = SSEParser()
    let text = """
      : a comment
      event: message
      data: {"type":"reasoning-delta","id":"r"}
      data: {"type":"error","errorText":"The model is busy."}
      data: not json
      data: {"type":"start"}
      data: [DONE]
      data: {"type":"finish"}

      """
    let events = parser.feed(text)
    #expect(events == [.unknown(type: "reasoning-delta"), .error("The model is busy."), .start(messageId: nil, conversationId: nil)])
    #expect(parser.dropped == 1)
    #expect(parser.isDone)
  }

  @Test func streamsFromTheClientAndMapsAProblem() async throws {
    let host = StubServer.host()
    StubURLProtocol.register(host: host) { call in
      if call.path == "/api/v1/assistant/chat" {
        let body = String(decoding: call.body, as: UTF8.self)
        if body.contains("busy") {
          return .init(status: 400, json: #"{"ok":false,"error":"Ask something shorter."}"#)
        }
        return .init(body: Data(Samples.chatStream.utf8), contentType: "text/event-stream")
      }
      return .init(status: 404, json: #"{"ok":false,"error":"Not found"}"#)
    }
    let (client, _) = try StubServer.client(host: host)
    var events: [ChatEvent] = []
    for try await event in client.chat(conversationId: nil, text: "Find the invoice") {
      events.append(event)
    }
    #expect(events == expected)
    let request = try #require(StubURLProtocol.calls(host: host).first)
    #expect(request.bearer == "ses_token")
    #expect(request.request.value(forHTTPHeaderField: "Accept") == "text/event-stream")
    await #expect(throws: APIError.server(status: 400, message: "Ask something shorter.")) {
      for try await _ in client.chat(conversationId: "ac_1", text: "busy") {}
    }
  }
}
