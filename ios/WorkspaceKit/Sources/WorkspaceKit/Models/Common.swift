import Foundation

/// A mail address with the name beside it, when there is one.
public struct Address: Codable, Hashable, Sendable {
  public var email: String
  public var name: String?

  public init(email: String, name: String? = nil) {
    self.email = email
    self.name = name
  }

  /// The name, or the address when there is none.
  public var displayName: String {
    if let name, !name.isEmpty { return name }
    return email
  }

  /// `Ada Lovelace <ada@acme.com>`, the form the send and draft endpoints take in their lists.
  public var typed: String {
    if let name, !name.isEmpty { return "\(name) <\(email)>" }
    return email
  }
}

/// The label palette: a text color and a soft fill per name.
public enum LabelColor: WireEnum {
  case gray, red, orange, amber, green, teal, blue, violet, pink
  case other(String)

  public static let known: [String: Self] = [
    "gray": .gray, "red": .red, "orange": .orange, "amber": .amber, "green": .green,
    "teal": .teal, "blue": .blue, "violet": .violet, "pink": .pink,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public struct LabelRef: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var color: LabelColor

  public init(id: String, name: String, color: LabelColor) {
    self.id = id
    self.name = name
    self.color = color
  }
}

/// Someone named by id: an owner, a sharer.
public struct Person: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String

  public init(id: String, name: String) {
    self.id = id
    self.name = name
  }
}

/// A colleague in the workspace, with their address.
public struct Colleague: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var email: String

  public init(id: String, name: String, email: String) {
    self.id = id
    self.name = name
    self.email = email
  }
}

/// `{ ok: true }`.
public struct OKResponse: Codable, Hashable, Sendable {
  public var ok: Bool
}

/// `{ ok: true, count }`.
public struct CountResponse: Codable, Hashable, Sendable {
  public var ok: Bool
  public var count: Int
}

/// `{ ok: false, error }`, the shape of every problem.
public struct Problem: Codable, Hashable, Sendable {
  public var ok: Bool?
  public var error: String?
}

/// `{ ids }`, the body of the actions on a selection.
public struct IdsRequest: Encodable, Hashable, Sendable {
  public var ids: [String]

  public init(ids: [String]) {
    self.ids = ids
  }
}
