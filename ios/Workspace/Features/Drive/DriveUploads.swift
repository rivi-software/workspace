import Foundation
import Observation
import WorkspaceKit

/// The uploads in flight, one queue for the process, so an upload started in a folder goes on
/// while the person browses elsewhere; a listing shows the ones bound for its folder.
@Observable @MainActor
final class DriveUploads {
  static let shared = DriveUploads()

  /// The most a file may be to go up in one request (API.md); larger ones go in parts.
  nonisolated static let simpleLimit: Int64 = 32 * 1024 * 1024

  struct Item: Identifiable, Hashable {
    let id: UUID
    let name: String
    let folderId: String
    let size: Int64
    /// 0 to 1 as the parts go up; nil while a whole file goes in one request.
    var progress: Double?
    var error: String?
  }

  private(set) var items: [Item] = []
  private var tasks: [UUID: Task<Void, Never>] = [:]

  func items(in folderId: String) -> [Item] {
    items.filter { $0.folderId == folderId }
  }

  /// Starts one upload per file; `finished` runs after each that lands.
  func start(
    _ files: [DrivePickedFile], folderId: String, client: WorkspaceClient,
    finished: @escaping @MainActor () async -> Void
  ) {
    for file in files {
      let item = Item(id: UUID(), name: file.name, folderId: folderId, size: file.size)
      items.append(item)
      tasks[item.id] = Task { [weak self] in
        await self?.run(item.id, file: file, folderId: folderId, client: client, finished: finished)
      }
    }
  }

  func cancel(_ id: UUID) {
    tasks[id]?.cancel()
    tasks[id] = nil
    items.removeAll { $0.id == id }
  }

  /// Drops a failed upload's row.
  func dismiss(_ id: UUID) {
    items.removeAll { $0.id == id }
  }

  private func run(
    _ id: UUID, file: DrivePickedFile, folderId: String, client: WorkspaceClient,
    finished: @MainActor () async -> Void
  ) async {
    defer {
      try? FileManager.default.removeItem(at: file.url)
      tasks[id] = nil
    }
    do {
      try await Self.send(file, folderId: folderId, client: client) { [weak self] fraction in
        self?.update(id) { $0.progress = fraction }
      }
      items.removeAll { $0.id == id }
      await finished()
    } catch is CancellationError {
      items.removeAll { $0.id == id }
    } catch {
      update(id) { $0.error = failureMessage(error) ?? "The upload failed." }
    }
  }

  private func update(_ id: UUID, _ change: (inout Item) -> Void) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
    change(&items[index])
  }

  /// Sends one file off the main actor: in one request up to `simpleLimit`, else in parts, with
  /// the upload aborted when a part fails or the person cancels.
  nonisolated private static func send(
    _ file: DrivePickedFile, folderId: String, client: WorkspaceClient,
    progress: @escaping @MainActor @Sendable (Double) -> Void
  ) async throws {
    if file.size <= simpleLimit {
      let data = try Data(contentsOf: file.url)
      _ = try await client.upload(data, folder: folderId, name: file.name, contentType: file.contentType)
      await progress(1)
      return
    }
    let start = try await client.startUpload(
      folder: folderId, name: file.name, size: file.size, type: file.contentType)
    do {
      let parts = try await sendParts(of: file, upload: start, client: client, progress: progress)
      _ = try await client.finishUpload(id: start.id, parts: parts)
    } catch {
      // In a task of its own: this one may be cancelled, which would cancel the abort's request too.
      Task { _ = try? await client.abortUpload(id: start.id) }
      throw error
    }
  }

  nonisolated private static func sendParts(
    of file: DrivePickedFile, upload: UploadStart, client: WorkspaceClient,
    progress: @escaping @MainActor @Sendable (Double) -> Void
  ) async throws -> [UploadedPart] {
    let handle = try FileHandle(forReadingFrom: file.url)
    defer { try? handle.close() }
    var parts: [UploadedPart] = []
    var sent: Int64 = 0
    while true {
      try Task.checkCancellation()
      guard let chunk = try handle.read(upToCount: Int(upload.partSize)), !chunk.isEmpty else { break }
      let part = try await client.uploadPart(id: upload.id, part: parts.count + 1, data: chunk)
      parts.append(part)
      sent += Int64(chunk.count)
      await progress(Double(sent) / Double(max(file.size, 1)))
    }
    return parts
  }
}
