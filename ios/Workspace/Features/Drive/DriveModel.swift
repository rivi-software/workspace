import Foundation
import Observation
import WorkspaceKit

/// One listing: the root in one of its views, or a folder, with the sort and the search on it.
@Observable @MainActor
final class DriveModel {
  /// The folder shown, or nil for the root and its views.
  let folderId: String?
  private(set) var view: DriveView = .mine
  /// The sort the person chose; nil leaves the server's default (name, or updated in Recent).
  private(set) var sort: DriveSort?
  private(set) var direction: SortDirection?
  /// The search field's text.
  var query = ""
  /// The search in effect, once submitted.
  private(set) var searched: String?
  var listing: LoadState<DriveListing> = .idle
  /// What the last change said went wrong.
  var actionError: String?
  /// Counts the loads, so a slow one cannot land over a later one's answer.
  private var generation = 0

  init(folderId: String? = nil) {
    self.folderId = folderId
  }

  var isRoot: Bool { folderId == nil }
  var isSearching: Bool { searched != nil }
  var isTrash: Bool { isRoot && !isSearching && view == .trash }
  var showsOwner: Bool { isRoot && !isSearching && view == .shared }
  var title: String { view.title }

  var effectiveSort: DriveSort {
    sort ?? (isRoot && !isSearching && view == .recent ? .updated : .name)
  }

  var effectiveDirection: SortDirection {
    direction ?? (effectiveSort == .name ? .asc : .desc)
  }

  /// Where an upload or a new folder goes: the folder's id, or "" for the root, which the server
  /// reads as the root.
  var writeFolderId: String { folderId ?? "" }

  // MARK: What is shown

  func select(view: DriveView) {
    guard view != self.view else { return }
    self.view = view
    listing = .loading
    actionError = nil
  }

  func setSort(_ sort: DriveSort) {
    self.sort = sort
  }

  func setDirection(_ direction: SortDirection) {
    self.direction = direction
  }

  func submitSearch() {
    let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else {
      clearSearch()
      return
    }
    searched = text
    listing = .loading
  }

  func clearSearch() {
    guard searched != nil else { return }
    searched = nil
    listing = .loading
  }

  // MARK: Loading

  func load(_ client: WorkspaceClient) async {
    generation += 1
    let mine = generation
    listing.begin()
    do {
      let result = try await fetch(client)
      guard mine == generation else { return }
      listing.finish(result)
    } catch {
      guard mine == generation else { return }
      listing.fail(error)
    }
  }

  private func fetch(_ client: WorkspaceClient) async throws -> DriveListing {
    if let searched {
      return try await client.drive(q: searched, sort: sort, direction: direction)
    }
    if let folderId {
      return try await client.drive(folder: folderId, sort: sort, direction: direction)
    }
    return try await client.drive(view: view, sort: sort, direction: direction)
  }

  // MARK: Changes

  func setStar(_ row: DriveRow, on: Bool, client: WorkspaceClient) async {
    await change { _ = try await client.star(ids: [row.id], on: on) }
  }

  func trash(_ row: DriveRow, client: WorkspaceClient) async {
    await change { _ = try await client.trash(ids: [row.id]) }
  }

  func restore(_ row: DriveRow, client: WorkspaceClient) async {
    await change { _ = try await client.restore(ids: [row.id]) }
  }

  func deleteForever(_ row: DriveRow, client: WorkspaceClient) async {
    await change { _ = try await client.deleteForever(ids: [row.id]) }
  }

  func rename(_ row: DriveRow, to name: String, client: WorkspaceClient) async {
    await change { _ = try await client.rename(id: row.id, name: name) }
  }

  func move(_ row: DriveRow, to targetId: String?, client: WorkspaceClient) async {
    await change { _ = try await client.move(ids: [row.id], targetId: targetId) }
  }

  func emptyTrash(client: WorkspaceClient) async {
    await change { _ = try await client.emptyDriveTrash() }
  }

  /// Runs a change and tells every listing to read again; a failure shows its words here.
  private func change(_ work: () async throws -> Void) async {
    actionError = nil
    do {
      try await work()
      ChangeSignal.drive.bump()
    } catch {
      actionError = failureMessage(error)
    }
  }
}
