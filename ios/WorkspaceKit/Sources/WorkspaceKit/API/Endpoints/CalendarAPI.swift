import Foundation

extension WorkspaceClient {
  /// `GET /calendar?from&to`: `to` excluded, at most 62 days. Ask a day of leeway each side of
  /// what is shown, since the reader's zone moves a UTC day.
  public func calendar(from: DayKey, to: DayKey) async throws -> CalendarData {
    try await get("/calendar", query: [("from", from.value), ("to", to.value)])
  }

  /// `POST /calendar/events`.
  public func createEvent(_ input: EventInput) async throws -> EventView {
    let answer: EventResult = try await post("/calendar/events", body: input)
    return answer.event
  }

  /// `PUT /calendar/events/:id`.
  public func updateEvent(id: String, _ input: EventInput) async throws -> EventView {
    let answer: EventResult = try await put("/calendar/events/\(pathComponent(id))", body: input)
    return answer.event
  }

  /// `DELETE /calendar/events/:id`.
  public func deleteEvent(id: String) async throws -> OKResponse {
    try await delete("/calendar/events/\(pathComponent(id))")
  }

  /// `POST /calendar/events/:id/respond` with `accepted` or `declined`.
  public func respond(eventId: String, status: AttendeeStatus) async throws -> EventView {
    let answer: EventResult = try await post(
      "/calendar/events/\(pathComponent(eventId))/respond", body: RespondRequest(status: status))
    return answer.event
  }
}
