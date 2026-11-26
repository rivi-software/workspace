import Foundation

#if canImport(Security)
  import Security
#endif

/// A sign-in: the workspace's session token (Better Auth's, the one its console's cookie carries),
/// the workspace it belongs to, and who signed in. The session lives 14 days from its last use and
/// ends when the person signs out, here or under Settings → Account in the console; there is no
/// refresh, so a `401` means signed out.
public struct Credentials: Codable, Hashable, Sendable {
  public var token: String
  public var server: URL
  public var email: String

  public init(token: String, server: URL, email: String) {
    self.token = token
    self.server = server
    self.email = email
  }
}

/// Where the sign-in is kept: the Keychain in the app, memory in tests.
public protocol TokenStore: Sendable {
  func load() throws -> Credentials?
  func save(_ credentials: Credentials) throws
  func clear() throws
}

/// A sign-in in memory, for tests and previews.
public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
  private let lock = NSLock()
  private var credentials: Credentials?

  public init(_ credentials: Credentials? = nil) {
    self.credentials = credentials
  }

  public func load() throws -> Credentials? {
    lock.withLock { credentials }
  }

  public func save(_ credentials: Credentials) throws {
    lock.withLock { self.credentials = credentials }
  }

  public func clear() throws {
    lock.withLock { credentials = nil }
  }
}

#if canImport(Security)
  public struct KeychainError: Error, Sendable, Equatable, LocalizedError {
    public let status: OSStatus
    public let operation: String

    /// `errSecMissingEntitlement`: an unsigned build (no `application-identifier`) cannot use the Keychain.
    public var errorDescription: String? {
      if status == -34018 {
        return "The Keychain refused the sign-in: this build is not signed. Run the app from Xcode, or build it signed."
      }
      let words = SecCopyErrorMessageString(status, nil).map { String($0) } ?? "status \(status)"
      return "The Keychain could not \(operation) the sign-in: \(words)"
    }
  }

  /// The sign-in as one generic password item in the Keychain, readable after the first unlock and
  /// never moved to another device.
  public struct KeychainTokenStore: TokenStore {
    public let service: String
    public let account: String

    public init(service: String = "software.rivi.workspace", account: String = "session") {
      self.service = service
      self.account = account
    }

    private var base: [String: Any] {
      [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
      ]
    }

    public func load() throws -> Credentials? {
      var query = base
      query[kSecReturnData as String] = true
      query[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &item)
      if status == errSecItemNotFound { return nil }
      guard status == errSecSuccess else { throw KeychainError(status: status, operation: "load") }
      guard let data = item as? Data else { return nil }
      // An item from an older build in another shape counts as no sign-in.
      return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    public func save(_ credentials: Credentials) throws {
      let data = try JSONEncoder().encode(credentials)
      let update: [String: Any] = [kSecValueData as String: data]
      let updated = SecItemUpdate(base as CFDictionary, update as CFDictionary)
      if updated == errSecSuccess { return }
      guard updated == errSecItemNotFound else {
        throw KeychainError(status: updated, operation: "save")
      }
      var add = base
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let added = SecItemAdd(add as CFDictionary, nil)
      guard added == errSecSuccess else { throw KeychainError(status: added, operation: "save") }
    }

    public func clear() throws {
      let status = SecItemDelete(base as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else {
        throw KeychainError(status: status, operation: "clear")
      }
    }
  }
#endif
