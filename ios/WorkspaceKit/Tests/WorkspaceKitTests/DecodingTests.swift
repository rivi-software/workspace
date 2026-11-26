import Foundation
import Testing

@testable import WorkspaceKit

struct DecodingTests {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder.workspace().decode(type, from: Data(json.utf8))
  }

  @Test func me() throws {
    let me = try decode(Me.self, Samples.me)
    #expect(me.user.role == .admin)
    #expect(me.counts.inboxUnread == 3)
    #expect(me.counts.labels["lb_1"] == 2)
    #expect(me.labels[0].color == .teal)
    #expect(me.labels[1].color == .other("magenta"))
    #expect(me.labels[1].color.rawValue == "magenta")
    #expect(me.driveUsed == 123_456_789)
    #expect(me.mailboxes.map(\.name) == ["Help desk"])
    #expect(me.mailboxes.first?.counts.inboxUnread == 4)
    #expect(me.github.connected)
    #expect(me.assistant.enabled)
    #expect(me.colleagues.first?.email == "bob@rivi.software")
  }

  @Test func threadList() throws {
    let list = try decode(ThreadList.self, Samples.threadList)
    #expect(list.folder == .inbox)
    #expect(list.label == nil)
    let row = try #require(list.threads.first)
    #expect(row.lastMessageAt == ISO8601.date(from: "2026-11-06T09:30:00Z"))
    #expect(row.snoozedUntil == nil)
    #expect(row.labels.first?.name == "Finance")
  }

  @Test func threadDetailWithUnknownFolderAndBothDateForms() throws {
    let detail = try decode(ThreadDetail.self, Samples.threadDetail)
    #expect(detail.thread.folder == .other("outbox"))
    #expect(detail.thread.participants[1].name == nil)
    #expect(detail.thread.participants[1].displayName == "ada@rivi.software")
    #expect(detail.thread.lastMessageAt == detail.messages[0].date)
    let message = detail.messages[0]
    #expect(message.direction == .inbound)
    #expect(message.deliveryStatus == .received)
    #expect(message.attachments[0].url == "/api/files/at_1?sig=abc")
  }

  @Test func drive() throws {
    let listing = try decode(DriveListing.self, Samples.drive)
    #expect(listing.view == .mine)
    #expect(listing.folder == nil)
    #expect(listing.rows[0].isFolder)
    #expect(listing.rows[1].role == .editor)
    #expect(listing.rows[1].parentId == "dn_1")
    let details = try decode(NodeDetails.self, Samples.node)
    #expect(details.preview == .pdf)
    #expect(details.shares[0].person == nil)
    #expect(details.shares[1].person?.name == "Ada")
  }

  @Test func calendarOccurrences() throws {
    let data = try decode(CalendarData.self, Samples.calendar)
    #expect(data.from == DayKey("2026-11-02"))
    let occurrence = try #require(data.events.first)
    #expect(occurrence.key == "ev_1:2026-11-03")
    #expect(occurrence.event.repeat == .weekly)
    #expect(occurrence.event.attendees[0].status == .accepted)
    #expect(occurrence.event.myStatus == nil)
    #expect(occurrence.start == occurrence.event.startsAt)
    let encoded = try JSONEncoder.workspace().encode(occurrence)
    let again = try JSONDecoder.workspace().decode(EventOccurrence.self, from: encoded)
    #expect(again == occurrence)
  }

  @Test func tasks() throws {
    let data = try decode(TasksData.self, Samples.tasks)
    #expect(data.view == .open)
    #expect(data.tasks[0].priority == .high)
    #expect(data.tasks[0].dueOn == DayKey("2026-11-07"))
    #expect(data.tasks[0].github == nil)
    #expect(data.tasks[1].github?.repo == "acme/app")
    #expect(data.tasks[1].github?.state == .open)
    #expect(data.github.connected)
    #expect(data.github.issues?.first?.id == "acme/app#14")
    #expect(data.github.issues?.first?.labels == ["bug"])
  }

  @Test func taskInputWritesNullOnlyToClearTheDueDay() throws {
    let encoder = JSONEncoder.workspace()
    let unchanged = String(decoding: try encoder.encode(TaskInput(title: "A")), as: UTF8.self)
    #expect(unchanged == #"{"title":"A"}"#)
    let cleared = String(decoding: try encoder.encode(TaskInput(dueOn: .cleared)), as: UTF8.self)
    #expect(cleared == #"{"dueOn":null}"#)
    let set = String(
      decoding: try encoder.encode(TaskInput(dueOn: .on(DayKey("2026-11-07")), priority: .low)),
      as: UTF8.self)
    #expect(set.contains(#""dueOn":"2026-11-07""#))
    #expect(set.contains(#""priority":"low""#))
  }

  @Test func assistantParts() throws {
    let detail = try decode(ConversationDetail.self, Samples.conversation)
    #expect(detail.messages[0].role == .user)
    #expect(detail.messages[0].text == "Find the invoice")
    let parts = detail.messages[1].parts
    #expect(parts[0] == .stepStart)
    guard case .tool(let step) = parts[1] else {
      Issue.record("Expected a tool step")
      return
    }
    #expect(step.tool == .searchMail)
    #expect(step.tool.stepLabel == "Searched mail")
    #expect(step.input?["query"]?.stringValue == "invoice")
    #expect(step.output?["count"] == .number(3))
    #expect(parts[3] == .other(type: "reasoning"))
    let list = try decode(ConversationList.self, #"{"conversations":[],"suggestions":["Hi"]}"#)
    #expect(list.suggestions == ["Hi"])
  }

  @Test func composeAndRequests() throws {
    let compose = try decode(ComposeData.self, Samples.compose)
    #expect(compose.prefill.mode == .reply)
    #expect(compose.froms[0].typed == "Ada Lovelace <ada@rivi.software>")
    let encoder = JSONEncoder.workspace()
    let chat = String(decoding: try encoder.encode(ChatRequest(conversationId: nil, text: "Hi")), as: UTF8.self)
    #expect(chat.contains(#""conversationId":null"#))
    #expect(chat.contains(#""parts":[{"text":"Hi","type":"text"}]"#) || chat.contains(#""parts":[{"type":"text","text":"Hi"}]"#))
    let folder = String(decoding: try encoder.encode(NewFolder(parentId: nil, name: "A")), as: UTF8.self)
    #expect(folder.contains(#""parentId":null"#))
    let snooze = Date(timeIntervalSince1970: 1_800_000_000)
    let action = String(
      decoding: try encoder.encode(ThreadAction(ids: ["th_1"], intent: .snooze, until: snooze)),
      as: UTF8.self)
    #expect(action.contains(#""until":"2027-01-15T08:00:00.000Z""#))
    #expect(action.contains(#""intent":"snooze""#))
    #expect(!action.contains("labelId"))
  }

  @Test func dayKey() throws {
    let day = DayKey("2026-11-07")
    let zone = try #require(TimeZone(identifier: "Europe/Amsterdam"))
    let midnight = try #require(day.date(in: zone))
    #expect(DayKey(midnight, in: zone) == day)
    #expect(DayKey(midnight.addingTimeInterval(-60), in: zone) == DayKey("2026-11-06"))
    #expect(DayKey("x").date() == nil)
    #expect(DayKey("2026-01-02") < DayKey("2026-01-10"))
  }

  @Test func datesInEitherForm() {
    let withFraction = ISO8601.date(from: "2026-11-06T09:30:00.000Z")
    let without = ISO8601.date(from: "2026-11-06T09:30:00Z")
    #expect(withFraction != nil)
    #expect(withFraction == without)
    #expect(ISO8601.date(from: "not a date") == nil)
    #expect(ISO8601.string(from: Date(timeIntervalSince1970: 0)) == "1970-01-01T00:00:00.000Z")
  }
}
