import Foundation

public enum TaskStatus: WireEnum {
  case open, done
  case other(String)

  public static let known: [String: Self] = ["open": .open, "done": .done]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum TaskPriority: WireEnum {
  case low, normal, high
  case other(String)

  public static let known: [String: Self] = ["low": .low, "normal": .normal, "high": .high]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

public enum IssueState: WireEnum {
  case open, closed
  case other(String)

  public static let known: [String: Self] = ["open": .open, "closed": .closed]
  public var unknownValue: String? {
    if case .other(let raw) = self { return raw }
    return nil
  }
}

/// The GitHub issue a task was made from, as the task last saw it.
public struct TaskIssue: Codable, Hashable, Sendable {
  /// `owner/name`.
  public var repo: String
  public var number: Int
  public var url: String
  public var title: String?
  public var state: IssueState?
  public var syncedAt: Date?
}

public struct TaskRow: Codable, Hashable, Sendable, Identifiable {
  public var id: String
  public var title: String
  public var notes: String
  public var status: TaskStatus
  public var priority: TaskPriority
  public var dueOn: DayKey?
  public var completedAt: Date?
  public var github: TaskIssue?
  public var updatedAt: Date
  public var createdAt: Date

  public var isDone: Bool { status == .done }
}

/// An open GitHub issue assigned to the person, which a task can be made from.
public struct GitHubIssue: Codable, Hashable, Sendable, Identifiable {
  /// `owner/name`.
  public var repo: String
  public var number: Int
  public var title: String
  public var url: String
  public var state: IssueState
  public var updatedAt: Date
  public var labels: [String]

  public var id: String { "\(repo)#\(number)" }
}

/// `GET /tasks?view=open|done`.
public struct TasksData: Codable, Hashable, Sendable {
  public var view: TaskStatus
  public var tasks: [TaskRow]
  public var github: TasksGitHub
}

/// The person's GitHub connection (Settings → Tasks in the console) and the open issues assigned
/// to them; `issues` is nil while GitHub is not connected or does not answer.
public struct TasksGitHub: Codable, Hashable, Sendable {
  public var connected: Bool
  public var issues: [GitHubIssue]?
}

/// A task's due day in a request: left as it is, cleared (`null`), or set to a day.
public enum DueDay: Hashable, Sendable {
  case unchanged
  case cleared
  case on(DayKey)
}

/// `POST /tasks` and `PUT /tasks/:id`: every field optional, a nil one left out of the body.
public struct TaskInput: Encodable, Hashable, Sendable {
  public var title: String?
  public var notes: String?
  public var dueOn: DueDay
  public var priority: TaskPriority?

  public init(
    title: String? = nil, notes: String? = nil, dueOn: DueDay = .unchanged,
    priority: TaskPriority? = nil
  ) {
    self.title = title
    self.notes = notes
    self.dueOn = dueOn
    self.priority = priority
  }

  enum CodingKeys: String, CodingKey { case title, notes, dueOn, priority }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(title, forKey: .title)
    try container.encodeIfPresent(notes, forKey: .notes)
    switch dueOn {
    case .unchanged: break
    case .cleared: try container.encodeNil(forKey: .dueOn)
    case .on(let day): try container.encode(day, forKey: .dueOn)
    }
    try container.encodeIfPresent(priority, forKey: .priority)
  }
}

public struct TaskResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var task: TaskRow
}

/// `POST /tasks/from-issue`: `existed` when the task was already there.
public struct TaskLinkResult: Codable, Hashable, Sendable {
  public var ok: Bool
  public var task: TaskRow
  public var existed: Bool
}

struct DoneRequest: Encodable, Sendable {
  var done: Bool
}

struct FromIssueRequest: Encodable, Sendable {
  var repo: String
  var number: Int
}
