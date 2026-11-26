import Foundation

public enum Role: WireEnum {
  case admin, member
  case other(String)

  public static let known: [String: Self] = ["admin": .admin, "member": .member]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public struct MeUser: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var email: String
  public var role: Role
}

/// The sidebar's counts: unread in the inbox and Spam, snoozed, drafts, scheduled, and unread per
/// label by its id.
public struct FolderCounts: Codable, Hashable, Sendable {
  public var inboxUnread: Int
  public var spamUnread: Int
  public var snoozed: Int
  public var drafts: Int
  public var scheduled: Int
  public var labels: [String: Int]

  public init(
    inboxUnread: Int = 0, spamUnread: Int = 0, snoozed: Int = 0, drafts: Int = 0,
    scheduled: Int = 0, labels: [String: Int] = [:]
  ) {
    self.inboxUnread = inboxUnread
    self.spamUnread = spamUnread
    self.snoozed = snoozed
    self.drafts = drafts
    self.scheduled = scheduled
    self.labels = labels
  }
}

public struct MailPreferences: Codable, Hashable, Sendable {
  /// The console's layout name; the contract does not enumerate it.
  public var layout: String
  public var undoSendSeconds: Int
  public var pageSize: Int
}

/// `GET /me`: the person, their counts, labels, preferences and colleagues.
public struct Me: Codable, Hashable, Sendable {
  public var user: MeUser
  public var appName: String
  public var counts: FolderCounts
  public var labels: [LabelRef]
  /// The shared group inboxes the person is in, by name; Mail opens one with `box`.
  public var mailboxes: [SharedMailbox]
  public var preferences: MailPreferences
  /// Drive bytes in use.
  public var driveUsed: Int64
  public var github: GitHubConnection
  public var colleagues: [Colleague]
  /// Whether the workspace's AI is on (`AI_FEATURES`): off, the Assistant is neither shown nor
  /// answered.
  public var assistant: AssistantAvailability
  /// The Assistant's opening questions, none while it is off.
  public var suggestions: [String]
}

/// A shared group inbox: one mailbox every member of the group reads and answers in Mail, with its
/// own counts and labels. Every Mail request takes its `id` as `box`.
public struct SharedMailbox: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var email: String
  public var counts: FolderCounts
  public var labels: [LabelRef]
}

public struct GitHubConnection: Codable, Hashable, Sendable {
  public var connected: Bool
}

public struct AssistantAvailability: Codable, Hashable, Sendable {
  public var enabled: Bool
}
