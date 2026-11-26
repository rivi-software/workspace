import Foundation

/// What a request can fail with, beyond the transport's own errors (`URLError`), which pass
/// through as they are.
public enum APIError: Error, Sendable, Equatable, LocalizedError {
  /// The server refused with its own words: `{ ok: false, error }` and its status.
  case server(status: Int, message: String)
  /// No usable session: nobody is signed in, or the workspace ended the session and the person
  /// signs in again.
  case unauthenticated
  /// An answer without the contract's shape.
  case badResponse(status: Int)
  /// The answer's JSON did not decode as the contract says.
  case decoding(String)

  public var errorDescription: String? {
    switch self {
    case .server(_, let message): message
    case .unauthenticated: "Sign in again to continue."
    case .badResponse(let status): "The workspace answered with status \(status)."
    case .decoding: "The workspace answered something this version of the app does not read."
    }
  }

  public var status: Int? {
    switch self {
    case .server(let status, _), .badResponse(let status): status
    case .unauthenticated: 401
    case .decoding: nil
    }
  }
}
