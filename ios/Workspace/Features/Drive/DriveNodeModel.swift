import Foundation
import Observation
import WorkspaceKit

/// A file's page: its details, the file itself once downloaded, and the changes to it.
@Observable @MainActor
final class DriveNodeModel {
  /// A file this size or smaller downloads on its own when it can be shown; a larger one waits
  /// for a tap.
  static let autoDownloadLimit: Int64 = 16 * 1024 * 1024

  let nodeId: String
  var details: LoadState<NodeDetails> = .idle
  var file: LoadState<DriveLocalFile> = .idle
  var actionError: String?
  /// Set once the node left this page's reach (trashed, restored, deleted): the view goes back.
  private(set) var left = false

  init(nodeId: String) {
    self.nodeId = nodeId
  }

  var node: DriveRow? { details.value?.node }

  /// Whether to download as soon as the details are in.
  var downloadsOnItsOwn: Bool {
    guard let details = details.value, details.preview != nil else { return false }
    return details.node.size <= Self.autoDownloadLimit
  }

  func load(_ client: WorkspaceClient) async {
    details.begin()
    do {
      details.finish(try await client.node(id: nodeId))
    } catch {
      details.fail(error)
    }
  }

  /// The file under its name, downloaded once; nil when the download failed (its words are shown).
  @discardableResult
  func download(_ client: WorkspaceClient) async -> DriveLocalFile? {
    if let file = file.value { return file }
    guard let node else { return nil }
    file.begin()
    do {
      let download = try await client.downloadFile(id: nodeId)
      let kept = try DriveFiles.keep(download, nodeId: nodeId, name: node.name)
      file.finish(kept)
      return kept
    } catch {
      file.fail(error)
      return nil
    }
  }

  // MARK: Changes

  func setStar(on: Bool, client: WorkspaceClient) async {
    await change {
      _ = try await client.star(ids: [nodeId], on: on)
      update { $0.node.starred = on }
    }
  }

  func rename(to name: String, client: WorkspaceClient) async {
    await change {
      let row = try await client.rename(id: nodeId, name: name)
      update { $0.node = row }
      // A kept download carries the old name: it follows, or the next download takes the new.
      if let kept = file.value {
        if let moved = try? DriveFiles.rename(kept, to: name) {
          file.finish(moved)
        } else {
          file = .idle
        }
      }
    }
  }

  func move(to targetId: String?, client: WorkspaceClient) async {
    await change {
      _ = try await client.move(ids: [nodeId], targetId: targetId)
      details.finish(try await client.node(id: nodeId))
    }
  }

  func trash(client: WorkspaceClient) async {
    await change {
      _ = try await client.trash(ids: [nodeId])
      left = true
    }
  }

  func restore(client: WorkspaceClient) async {
    await change {
      _ = try await client.restore(ids: [nodeId])
      left = true
    }
  }

  func deleteForever(client: WorkspaceClient) async {
    await change {
      _ = try await client.deleteForever(ids: [nodeId])
      left = true
    }
  }

  private func update(_ edit: (inout NodeDetails) -> Void) {
    guard var current = details.value else { return }
    edit(&current)
    details.finish(current)
  }

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
