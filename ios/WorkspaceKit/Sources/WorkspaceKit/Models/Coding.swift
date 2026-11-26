import Foundation

/// Moments on the wire: ISO 8601 in UTC, with or without fractional seconds.
public enum ISO8601 {
  private static let styles: [Date.ISO8601FormatStyle] = [
    Date.ISO8601FormatStyle(includingFractionalSeconds: true),
    Date.ISO8601FormatStyle(),
    Date.ISO8601FormatStyle(timeZoneSeparator: .colon, includingFractionalSeconds: true),
    Date.ISO8601FormatStyle(timeZoneSeparator: .colon),
  ]

  /// Reads `2026-11-06T09:30:00.000Z`, `2026-11-06T09:30:00Z` and an offset form of either.
  public static func date(from string: String) -> Date? {
    for style in styles {
      if let date = try? style.parse(string) { return date }
    }
    return nil
  }

  /// Writes a moment as the server does: UTC with milliseconds.
  public static func string(from date: Date) -> String {
    Date.ISO8601FormatStyle(includingFractionalSeconds: true).format(date)
  }
}

extension JSONDecoder {
  /// The decoder for every answer: tolerant ISO 8601 dates, everything else as declared.
  public static func workspace() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let container = try decoder.singleValueContainer()
      let string = try container.decode(String.self)
      guard let date = ISO8601.date(from: string) else {
        throw DecodingError.dataCorruptedError(
          in: container, debugDescription: "Not an ISO 8601 moment: \(string)")
      }
      return date
    }
    return decoder
  }
}

extension JSONEncoder {
  /// The encoder for every request body: dates as UTC ISO 8601 with milliseconds.
  public static func workspace() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(ISO8601.string(from: date))
    }
    return encoder
  }
}

/// Percent-encoding for query strings and form bodies: everything but the unreserved characters
/// (RFC 3986) is escaped, a space as `%20`, so a `+` in a search term stays a plus.
public enum PercentEncoding {
  private static let unreserved: CharacterSet = {
    var set = CharacterSet.alphanumerics
    set.insert(charactersIn: "-._~")
    return set
  }()

  public static func encode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
  }

  /// `a=1&b=two%20words`, in the order given, nil values left out.
  public static func query(_ items: [(String, String?)]) -> String {
    items.compactMap { key, value in
      guard let value else { return nil }
      return "\(encode(key))=\(encode(value))"
    }.joined(separator: "&")
  }

  /// An `application/x-www-form-urlencoded` body.
  public static func form(_ items: [(String, String)]) -> Data {
    Data(query(items.map { ($0.0, $0.1) }).utf8)
  }
}
