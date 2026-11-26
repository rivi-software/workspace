import Foundation
import Observation
import WorkspaceKit

/// The rows of every page loaded so far, and where the next page starts.
struct MailPage {
  var threads: [ListRow]
  var drafts: [DraftRow]
  var page: Int
  var pageSize: Int
  var total: Int
  var label: LabelRef?

  init(_ list: ThreadList) {
    threads = list.threads
    drafts = list.drafts
    page = list.page
    pageSize = list.pageSize
    total = list.total
    label = list.label
  }

  var hasMore: Bool { page * pageSize < total }

  /// Adds the next page; a row already shown (the list moved under us) is not shown twice.
  mutating func append(_ list: ThreadList) {
    let knownThreads = Set(threads.map(\.id))
    threads += list.threads.filter { !knownThreads.contains($0.id) }
    let knownDrafts = Set(drafts.map(\.id))
    drafts += list.drafts.filter { !knownDrafts.contains($0.id) }
    page = list.page
    total = list.total
  }
}

/// An action just done, for as long as the capsule offers to take it back.
struct MailUndo: Identifiable, Equatable {
  let id: UUID
  let token: String
  let words: String
}

/// The list: its view and search, the pages loaded, the selection, the rows on their way out and
/// the undo on offer.
@Observable @MainActor
final class MailModel {
  private static let undoSeconds = 5

  private(set) var view: MailView = .folder(.inbox)
  /// The shared group inbox listed, or nil for the person's own mailbox (`AppModel.box`).
  private(set) var box: String?
  /// The search box's text; `query` is what was submitted.
  var searchText = ""
  private(set) var query = ""
  var list: LoadState<MailPage> = .idle
  private(set) var isLoadingMore = false
  var selection: Set<String> = []
  /// Rows hidden the moment an action on them started, until the list reloads.
  private(set) var leaving: Set<String> = []
  /// Rows whose action the server has not answered yet: a reload in the meantime still has them
  /// where they were, so they stay hidden through it.
  private var acting: Set<String> = []
  private(set) var undo: MailUndo?
  /// What the last action said went wrong.
  var actionError: String?
  private var generation = 0
  private var undoTimer: Task<Void, Never>?

  var title: String { query.isEmpty ? view.title : "Search" }
  /// A search lists conversations, whatever the folder.
  var listsDrafts: Bool { query.isEmpty && view.listsDrafts }
  var threads: [ListRow] { (list.value?.threads ?? []).filter { !leaving.contains($0.id) } }
  var drafts: [DraftRow] { list.value?.drafts ?? [] }
  var isEmpty: Bool { threads.isEmpty && drafts.isEmpty }

  private var folderParameter: MailFolder? { view.label == nil ? view.folder : nil }
  private var queryParameter: String? { query.isEmpty ? nil : query }

  // MARK: Views

  func show(_ view: MailView, _ client: WorkspaceClient) async {
    guard view != self.view || !query.isEmpty else { return }
    self.view = view
    query = ""
    searchText = ""
    reset()
    await load(client)
  }

  /// Lists another mailbox, from its inbox: a label or a search of one mailbox means nothing in
  /// another.
  func showMailbox(_ box: String?, _ client: WorkspaceClient) async {
    guard box != self.box else { return }
    self.box = box
    view = .folder(.inbox)
    query = ""
    searchText = ""
    undoTimer?.cancel()
    undo = nil
    reset()
    await load(client)
  }

  func search(_ client: WorkspaceClient) async {
    let submitted = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    guard submitted != query else { return }
    query = submitted
    reset()
    await load(client)
  }

  /// The search box was cleared: back to the folder.
  func clearSearch(_ client: WorkspaceClient) async {
    guard !query.isEmpty else { return }
    query = ""
    reset()
    await load(client)
  }

  private func reset() {
    list = .idle
    selection = []
    leaving = []
    actionError = nil
  }

  // MARK: Loading

  /// Loads the list again, as many pages as were shown, so a reload (after an action, back from a
  /// conversation, the minute's tick) leaves the person where they scrolled to. What is shown
  /// stays while it runs.
  func load(_ client: WorkspaceClient) async {
    generation += 1
    let mine = generation
    let pages = list.value?.page ?? 1
    list.begin()
    do {
      var fresh = MailPage(try await page(1, client))
      for number in stride(from: 2, through: pages, by: 1) where fresh.hasMore {
        guard mine == generation else { return }
        fresh.append(try await page(number, client))
      }
      guard mine == generation else { return }
      leaving.formIntersection(acting)
      list.finish(fresh)
    } catch {
      guard mine == generation else { return }
      list.fail(error)
    }
  }

  /// The next page, once the last row shows.
  func loadMore(_ client: WorkspaceClient) async {
    guard let page = list.value, page.hasMore, !isLoadingMore else { return }
    let mine = generation
    isLoadingMore = true
    defer { isLoadingMore = false }
    do {
      let answer = try await self.page(page.page + 1, client)
      guard mine == generation, var current = list.value else { return }
      current.append(answer)
      list.finish(current)
    } catch {
      guard mine == generation else { return }
      actionError = failureMessage(error)
    }
  }

  /// One page of this view and search.
  private func page(_ number: Int, _ client: WorkspaceClient) async throws -> ThreadList {
    try await client.threads(
      folder: folderParameter, label: view.label?.id, q: queryParameter, page: number, box: box)
  }

  func isLast(_ id: String) -> Bool {
    threads.last?.id == id || drafts.last?.id == id
  }

  // MARK: Actions

  /// Does `intent` to `ids`: the rows it takes out of this view go at once, the capsule offers to
  /// undo it and the list reloads. Nil when the server refused; the rows come back then.
  @discardableResult
  func act(
    _ intent: ThreadIntent, on ids: [String], until: Date? = nil, labelId: String? = nil,
    client: WorkspaceClient
  ) async -> ThreadActionResult? {
    let action = ThreadAction(ids: ids, intent: intent, until: until, labelId: labelId)
    actionError = nil
    hide(after: action)
    selection.subtract(ids)
    acting.formUnion(ids)
    do {
      let result = try await client.act(action, box: box)
      acting.subtract(ids)
      offerUndo(result, for: action)
      await load(client)
      return result
    } catch {
      acting.subtract(ids)
      leaving.subtract(ids)
      actionError = failureMessage(error)
      return nil
    }
  }

  /// The conversation view did an action: its row goes when the action takes it out of this view
  /// and the capsule offers to undo it. The list reloads as the view comes back.
  func note(_ result: ThreadActionResult, for action: ThreadAction) {
    hide(after: action)
    offerUndo(result, for: action)
  }

  /// What the selected conversations have in common, for the action bar's menu.
  func facts(for ids: Set<String>) -> MailThreadFacts {
    MailThreadFacts(rows: threads.filter { ids.contains($0.id) }, fallback: view.folder ?? .inbox)
  }

  private func hide(after action: ThreadAction) {
    for row in list.value?.threads ?? [] where action.ids.contains(row.id) {
      if MailViewRules.leaves(MailViewedThread(row), after: action, in: view, query: query) {
        leaving.insert(row.id)
      }
    }
  }

  private func offerUndo(_ result: ThreadActionResult, for action: ThreadAction) {
    undoTimer?.cancel()
    guard let token = result.undo else {
      undo = nil
      return
    }
    let offered = MailUndo(id: UUID(), token: token, words: MailIntentWords.done(action.intent, count: result.count))
    undo = offered
    undoTimer = Task { [weak self] in
      try? await Task.sleep(for: .seconds(Self.undoSeconds))
      guard !Task.isCancelled, let self, self.undo == offered else { return }
      self.undo = nil
    }
  }

  /// Takes the last action back and reloads.
  func undoLast(_ client: WorkspaceClient) async {
    guard let undo else { return }
    undoTimer?.cancel()
    self.undo = nil
    actionError = nil
    do {
      _ = try await client.undo(undo.token, box: box)
      await load(client)
    } catch {
      actionError = failureMessage(error)
    }
  }

  /// Every conversation of this view becomes read.
  func readAll(_ client: WorkspaceClient) async {
    actionError = nil
    do {
      _ = try await client.readAll(
        ReadAllRequest(folder: folderParameter, label: view.label?.id, q: queryParameter), box: box)
      await load(client)
    } catch {
      actionError = failureMessage(error)
    }
  }

  /// Deletes everything in the trash or Spam for good.
  func empty(_ client: WorkspaceClient) async {
    guard view.canEmpty, let folder = view.folder else { return }
    actionError = nil
    do {
      _ = try await client.empty(folder: folder, box: box)
      await load(client)
    } catch {
      actionError = failureMessage(error)
    }
  }
}
