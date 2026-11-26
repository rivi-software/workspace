import Foundation

extension WorkspaceClient {
  /// `GET /me`: the person, their counts, labels, preferences and colleagues.
  public func me() async throws -> Me {
    try await get("/me")
  }
}
