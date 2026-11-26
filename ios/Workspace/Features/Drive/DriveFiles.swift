import Foundation
import UniformTypeIdentifiers
import WorkspaceKit

/// A file on this device: a download kept under its node's name, for a preview or a share.
struct DriveLocalFile: Hashable, Sendable, Identifiable {
  let url: URL
  let name: String
  let contentType: String?

  var id: URL { url }
}

/// The feature's corner of the temporary directory: picks waiting to go up, and downloads kept
/// under their node's name so QuickLook and the share sheet show the right name and type.
enum DriveFiles {
  private static var root: URL {
    FileManager.default.temporaryDirectory.appending(path: "Drive", directoryHint: .isDirectory)
  }

  /// A place of its own for a picked file, so two picks with one name do not collide.
  static func scratch(name: String) throws -> URL {
    let folder = root.appending(path: "picks/\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder.appending(path: safe(name))
  }

  /// Moves a download under the node's name, replacing an earlier copy.
  static func keep(_ download: DownloadedFile, nodeId: String, name: String) throws -> DriveLocalFile {
    let folder = root.appending(path: "nodes/\(safe(nodeId))", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let destination = folder.appending(path: safe(name))
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.moveItem(at: download.url, to: destination)
    return DriveLocalFile(url: destination, name: name, contentType: download.contentType)
  }

  /// Moves a kept download beside itself under a new name, after a rename.
  static func rename(_ file: DriveLocalFile, to name: String) throws -> DriveLocalFile {
    let destination = file.url.deletingLastPathComponent().appending(path: safe(name))
    guard destination != file.url else { return file }
    if FileManager.default.fileExists(atPath: destination.path) {
      try FileManager.default.removeItem(at: destination)
    }
    try FileManager.default.moveItem(at: file.url, to: destination)
    return DriveLocalFile(url: destination, name: name, contentType: file.contentType)
  }

  /// The media type the name's extension says, else bytes.
  static func mimeType(forName name: String) -> String {
    let ext = DriveIcons.extension(of: name)
    guard !ext.isEmpty, let type = UTType(filenameExtension: ext), let mime = type.preferredMIMEType else {
      return "application/octet-stream"
    }
    return mime
  }

  /// The bytes a file holds, or 0 when it cannot be read.
  static func size(of url: URL) -> Int64 {
    let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes?[.size] as? NSNumber)?.int64Value ?? 0
  }

  /// A name the file system takes: no slash, no colon, never empty.
  private static func safe(_ name: String) -> String {
    let cleaned = name
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: ":", with: "_")
    return cleaned.isEmpty ? "file" : cleaned
  }
}
