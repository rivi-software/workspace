import Foundation

/// A string enum the server may extend: an unknown value decodes to `.other(raw)` instead of
/// failing, so a server change never crashes the app. Each enum lists its `known` values and
/// keeps an `other(String)` case; `init(rawValue:)`, `rawValue` and `Codable` come from this
/// extension. It is deliberately not `RawRepresentable`: the standard library's `==` for that
/// protocol compares raw values, and `rawValue` here is found through `==`, which recursed.
public protocol WireEnum: Codable, Hashable, Sendable {
  static var known: [String: Self] { get }
  static func other(_ raw: String) -> Self
  /// The raw value when this is an `.other` case, else nil.
  var unknownValue: String? { get }
}

extension WireEnum {
  public init(rawValue: String) {
    self = Self.known[rawValue] ?? Self.other(rawValue)
  }

  public var rawValue: String {
    if let unknownValue { return unknownValue }
    return Self.known.first { $0.value == self }?.key ?? ""
  }

  public var isKnown: Bool { unknownValue == nil }

  public init(from decoder: any Decoder) throws {
    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}

/// A day as the server writes it, `YYYY-MM-DD` in the reader's zone (a task's due day, a
/// calendar range). It stays a string on the wire; `date(in:)` gives that day's local midnight.
public struct DayKey: Hashable, Sendable, Codable, Comparable, CustomStringConvertible {
  public let value: String

  public init(_ value: String) {
    self.value = value
  }

  /// The day `date` falls on in `zone`.
  public init(_ date: Date, in zone: TimeZone = .current) {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    let parts = calendar.dateComponents([.year, .month, .day], from: date)
    let year = parts.year ?? 1970
    let month = parts.month ?? 1
    let day = parts.day ?? 1
    value = String(format: "%04d-%02d-%02d", year, month, day)
  }

  public init(from decoder: any Decoder) throws {
    value = try decoder.singleValueContainer().decode(String.self)
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(value)
  }

  /// Midnight at the start of this day in `zone`, or nil when the string is no day.
  public func date(in zone: TimeZone = .current) -> Date? {
    let parts = value.split(separator: "-").compactMap { Int($0) }
    guard parts.count == 3 else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = zone
    return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
  }

  public var description: String { value }

  public static func < (lhs: DayKey, rhs: DayKey) -> Bool { lhs.value < rhs.value }
}

/// Any JSON value: a tool's input and output in the Assistant's parts, which the contract leaves
/// open.
public enum JSONValue: Hashable, Sendable, Codable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case null
  case array([JSONValue])
  case object([String: JSONValue])

  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let bool = try? container.decode(Bool.self) {
      self = .bool(bool)
    } else if let number = try? container.decode(Double.self) {
      self = .number(number)
    } else if let string = try? container.decode(String.self) {
      self = .string(string)
    } else if let array = try? container.decode([JSONValue].self) {
      self = .array(array)
    } else if let object = try? container.decode([String: JSONValue].self) {
      self = .object(object)
    } else {
      throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not a JSON value")
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let string): try container.encode(string)
    case .number(let number): try container.encode(number)
    case .bool(let bool): try container.encode(bool)
    case .null: try container.encodeNil()
    case .array(let array): try container.encode(array)
    case .object(let object): try container.encode(object)
    }
  }

  public subscript(key: String) -> JSONValue? {
    if case .object(let object) = self { return object[key] }
    return nil
  }

  public var stringValue: String? {
    if case .string(let string) = self { return string }
    return nil
  }
}
