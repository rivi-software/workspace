import CoreTransferable
import Foundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// A file chosen for upload, copied under the app's temporary directory with its name, type and
/// size; the upload deletes the copy once it is done with it.
struct DrivePickedFile: Hashable, Sendable {
  let url: URL
  let name: String
  let contentType: String
  let size: Int64

  init(url: URL, name: String) {
    self.url = url
    self.name = name
    contentType = DriveFiles.mimeType(forName: name)
    size = DriveFiles.size(of: url)
  }

  /// A file from the document picker, copied while its security scope lasts (it ends with the
  /// picker's callback).
  static func imported(_ url: URL) throws -> DrivePickedFile {
    let scoped = url.startAccessingSecurityScopedResource()
    defer {
      if scoped { url.stopAccessingSecurityScopedResource() }
    }
    let copy = try DriveFiles.scratch(name: url.lastPathComponent)
    try FileManager.default.copyItem(at: url, to: copy)
    return DrivePickedFile(url: copy, name: url.lastPathComponent)
  }

  /// A photo or video from the picker: the library's file with its name when the picker gives
  /// one, else its bytes under a name made from the moment.
  static func picked(_ item: PhotosPickerItem) async throws -> DrivePickedFile {
    let type = item.supportedContentTypes.first
    let ext = type?.preferredFilenameExtension ?? "bin"
    if let media = try await item.loadTransferable(type: DrivePickedMedia.self) {
      var name = media.url.lastPathComponent
      if DriveIcons.extension(of: name).isEmpty { name += ".\(ext)" }
      return DrivePickedFile(url: media.url, name: name)
    }
    guard let data = try await item.loadTransferable(type: Data.self) else {
      throw DrivePickError.unreadable
    }
    let what = type?.conforms(to: .movie) == true ? "Video" : "Photo"
    let stamp = Date.now.formatted(
      .iso8601.year().month().day().time(includingFractionalSeconds: false)
        .timeSeparator(.omitted).dateTimeSeparator(.space))
    let name = "\(what) \(stamp).\(ext)"
    let url = try DriveFiles.scratch(name: name)
    try data.write(to: url)
    return DrivePickedFile(url: url, name: name)
  }
}

/// The picker's item as a file, copied so it outlives the transfer and keeps the library's name.
struct DrivePickedMedia: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .item) { received in
      let copy = try DriveFiles.scratch(name: received.file.lastPathComponent)
      try FileManager.default.copyItem(at: received.file, to: copy)
      return DrivePickedMedia(url: copy)
    }
  }
}

enum DrivePickError: LocalizedError {
  case unreadable

  var errorDescription: String? {
    switch self {
    case .unreadable: "That item could not be read."
    }
  }
}
