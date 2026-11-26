import Foundation

public enum EventRepeat: WireEnum {
  case none, daily, weekly, monthly, yearly
  case other(String)

  public static let known: [String: Self] = [
    "none": .none, "daily": .daily, "weekly": .weekly, "monthly": .monthly, "yearly": .yearly,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum AttendeeStatus: WireEnum {
  case needsAction, accepted, declined
  case other(String)

  public static let known: [String: Self] = [
    "needs-action": .needsAction, "accepted": .accepted, "declined": .declined,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public struct Attendee: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var status: AttendeeStatus
}

/// `POST /calendar/events` and `PUT /calendar/events/:id`. An all-day event's `startsAt` and
/// `endsAt` are the UTC midnights of its first day and the day after its last. `timeZone` is the
/// IANA zone it was made in, the reader's by default; `attendees` are colleagues' ids.
public struct EventInput: Encodable, Hashable, Sendable {
  public var title: String
  public var description: String?
  public var location: String?
  public var startsAt: Date
  public var endsAt: Date
  public var allDay: Bool
  public var timeZone: String?
  public var `repeat`: EventRepeat?
  public var repeatUntil: Date?
  public var attendees: [String]?

  public init(
    title: String, description: String? = nil, location: String? = nil, startsAt: Date,
    endsAt: Date, allDay: Bool = false, timeZone: String? = TimeZone.current.identifier,
    repeat: EventRepeat? = nil, repeatUntil: Date? = nil, attendees: [String]? = nil
  ) {
    self.title = title
    self.description = description
    self.location = location
    self.startsAt = startsAt
    self.endsAt = endsAt
    self.allDay = allDay
    self.timeZone = timeZone
    self.repeat = `repeat`
    self.repeatUntil = repeatUntil
    self.attendees = attendees
  }
}

public struct EventView: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var owner: Person
  public var mine: Bool
  public var title: String
  public var description: String
  public var location: String
  public var startsAt: Date
  public var endsAt: Date
  public var allDay: Bool
  public var timeZone: String
  public var `repeat`: EventRepeat
  public var repeatUntil: Date?
  public var attendees: [Attendee]
  public var myStatus: AttendeeStatus?
  public var updatedAt: Date
}

/// One time a repeating event happens: the event's fields with `key`, `start` and `end` beside them.
public struct EventOccurrence: Codable, Hashable, Sendable, Identifiable {
  public var event: EventView
  public var key: String
  public var start: Date
  public var end: Date

  public var id: String { key }

  enum CodingKeys: String, CodingKey { case key, start, end }

  public init(event: EventView, key: String, start: Date, end: Date) {
    self.event = event
    self.key = key
    self.start = start
    self.end = end
  }

  public init(from decoder: any Decoder) throws {
    event = try EventView(from: decoder)
    let container = try decoder.container(keyedBy: CodingKeys.self)
    key = try container.decode(String.self, forKey: .key)
    start = try container.decode(Date.self, forKey: .start)
    end = try container.decode(Date.self, forKey: .end)
  }

  public func encode(to encoder: any Encoder) throws {
    try event.encode(to: encoder)
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(key, forKey: .key)
    try container.encode(start, forKey: .start)
    try container.encode(end, forKey: .end)
  }
}

/// `GET /calendar?from&to`: `to` excluded.
public struct CalendarData: Codable, Hashable, Sendable {
  public var from: DayKey
  public var to: DayKey
  public var events: [EventOccurrence]
  public var tasks: [TaskRow]
  public var colleagues: [Colleague]
}

public struct EventResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var event: EventView
}

/// `POST /calendar/events/:id/respond`.
public struct RespondRequest: Encodable, Hashable, Sendable {
  public var status: AttendeeStatus

  public init(status: AttendeeStatus) {
    self.status = status
  }
}
