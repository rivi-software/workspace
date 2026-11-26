import Foundation

public enum DriveKind: WireEnum {
  case folder, file
  case other(String)

  public static let known: [String: Self] = ["folder": .folder, "file": .file]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum DriveRole: WireEnum {
  case owner, editor, viewer
  case other(String)

  public static let known: [String: Self] = ["owner": .owner, "editor": .editor, "viewer": .viewer]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

/// The Drive views beside a folder listing.
public enum DriveView: WireEnum {
  case mine, shared, recent, starred, trash
  case other(String)

  public static let known: [String: Self] = [
    "mine": .mine, "shared": .shared, "recent": .recent, "starred": .starred, "trash": .trash,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum DriveSort: String, Sendable, Hashable {
  case name, updated, size
}

public enum SortDirection: String, Sendable, Hashable {
  case asc, desc
}

public enum DrivePreview: WireEnum {
  case image, audio, video, pdf, text, code
  case other(String)

  public static let known: [String: Self] = [
    "image": .image, "audio": .audio, "video": .video, "pdf": .pdf, "text": .text, "code": .code,
  ]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public struct DriveRow: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var kind: DriveKind
  public var name: String
  public var contentType: String
  public var size: Int64
  public var updatedAt: Date
  public var createdAt: Date
  public var trashedAt: Date?
  public var starred: Bool
  public var shared: Bool
  public var linked: Bool
  public var role: DriveRole
  public var owner: Person
  public var parentId: String?

  public var isFolder: Bool { kind == .folder }
}

public struct FolderView: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var role: DriveRole
  public var owner: Person
  public var starred: Bool
  public var shared: Bool
  public var linked: Bool
}

public struct Crumb: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
}

/// `GET /drive`: a folder, a view or a search.
public struct DriveListing: Codable, Hashable, Sendable {
  public var view: DriveView
  public var q: String?
  public var folder: FolderView?
  public var crumbs: [Crumb]
  public var rows: [DriveRow]
  public var canWrite: Bool
  /// Drive bytes in use.
  public var used: Int64
}

public struct DriveShare: Codable, Hashable, Sendable {
  /// Nil when the share is with everyone.
  public var person: Person?
  public var role: DriveRole
}

/// `GET /drive/nodes/:id`.
public struct NodeDetails: Codable, Hashable, Sendable {
  public var node: DriveRow
  public var crumbs: [Crumb]
  public var preview: DrivePreview?
  public var shares: [DriveShare]
}

public struct NodeResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var node: DriveRow
}

/// `POST /drive/upload` with `intent: "start"`.
public struct UploadStart: Codable, Hashable, Sendable {
  public var ok: Bool
  public var id: String
  public var uploadId: String
  public var partSize: Int64
}

public struct UploadedPart: Codable, Hashable, Sendable {
  public var partNumber: Int
  public var etag: String

  public init(partNumber: Int, etag: String) {
    self.partNumber = partNumber
    self.etag = etag
  }
}

public struct UploadPartResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var part: UploadedPart
}

/// `{ parentId: string | null, name }`: `parentId` is written as `null` for the root, never left out.
public struct NewFolder: Encodable, Hashable, Sendable {
  public var parentId: String?
  public var name: String

  public init(parentId: String?, name: String) {
    self.parentId = parentId
    self.name = name
  }

  enum CodingKeys: String, CodingKey { case parentId, name }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(parentId, forKey: .parentId)
    try container.encode(name, forKey: .name)
  }
}

/// `{ ids, targetId: string | null }`: `targetId` is written as `null` for the root.
public struct MoveRequest: Encodable, Hashable, Sendable {
  public var ids: [String]
  public var targetId: String?

  public init(ids: [String], targetId: String?) {
    self.ids = ids
    self.targetId = targetId
  }

  enum CodingKeys: String, CodingKey { case ids, targetId }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(ids, forKey: .ids)
    try container.encode(targetId, forKey: .targetId)
  }
}

struct RenameRequest: Encodable, Sendable {
  var name: String
}

struct StarRequest: Encodable, Sendable {
  var ids: [String]
  var on: Bool
}

struct UploadIntent: Encodable, Sendable {
  var intent: String
  var id: String?
  var folder: String?
  var name: String?
  var size: Int64?
  var type: String?
  var parts: [UploadedPart]?
}
