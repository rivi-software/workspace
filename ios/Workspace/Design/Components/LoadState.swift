import Foundation

/// What a screen has of its data. `failed` keeps what was shown, so a reload that fails shows its
/// words over the stale list rather than an empty screen. Change it in synchronous steps around
/// an `await`, never through a mutating call that spans one.
enum LoadState<Value> {
  case idle
  case loading
  case loaded(Value)
  case failed(String, Value?)

  var value: Value? {
    switch self {
    case .loaded(let value): value
    case .failed(_, let value): value
    case .idle, .loading: nil
    }
  }

  var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }

  /// Starts a load; what is shown stays while it runs.
  mutating func begin() {
    if value == nil { self = .loading }
  }

  mutating func finish(_ value: Value) {
    self = .loaded(value)
  }

  /// Records a failure with the server's words; a cancelled load (the view went away) leaves the
  /// state as it was.
  mutating func fail(_ error: any Error) {
    guard let message = failureMessage(error) else { return }
    self = .failed(message, value)
  }
}

/// The words for an error, or nil for a cancellation nobody needs to read about.
func failureMessage(_ error: any Error) -> String? {
  if error is CancellationError { return nil }
  if let urlError = error as? URLError, urlError.code == .cancelled { return nil }
  return error.localizedDescription
}
