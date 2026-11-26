import Foundation

extension WorkspaceClient {
  /// `GET /tasks?view=open|done`.
  public func tasks(view: TaskStatus = .open) async throws -> TasksData {
    try await get("/tasks", query: [("view", view.rawValue)])
  }

  /// `POST /tasks`.
  public func createTask(_ input: TaskInput) async throws -> TaskRow {
    let answer: TaskResult = try await post("/tasks", body: input)
    return answer.task
  }

  /// `PUT /tasks/:id`, each field optional.
  public func updateTask(id: String, _ input: TaskInput) async throws -> TaskRow {
    let answer: TaskResult = try await put("/tasks/\(pathComponent(id))", body: input)
    return answer.task
  }

  /// `DELETE /tasks/:id`.
  public func deleteTask(id: String) async throws -> OKResponse {
    try await delete("/tasks/\(pathComponent(id))")
  }

  /// `POST /tasks/:id/done`: marks the task done, or open again with `done: false`. A task made
  /// from an issue closes or reopens the issue first; when GitHub refuses, the workspace's words
  /// come back as `APIError.server` and the task stays as it was.
  public func setTaskDone(id: String, done: Bool) async throws -> TaskRow {
    let answer: TaskResult = try await post(
      "/tasks/\(pathComponent(id))/done", body: DoneRequest(done: done))
    return answer.task
  }

  /// `POST /tasks/from-issue`: a task from one of the person's GitHub issues.
  public func taskFromIssue(_ issue: GitHubIssue) async throws -> TaskLinkResult {
    try await post(
      "/tasks/from-issue", body: FromIssueRequest(repo: issue.repo, number: issue.number))
  }
}
