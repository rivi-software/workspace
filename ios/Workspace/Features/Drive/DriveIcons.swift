import SwiftUI
import WorkspaceKit

/// A node's kind as the console tells it (`fileKind` in `app/lib/drive/drive.ts`): the content
/// type first, the name's extension second, so both clients show one icon for one file.
enum DriveFileKind {
  case folder, image, audio, video, pdf, text, code, archive, document, sheet, slides, file

  init(_ row: DriveRow) {
    self.init(contentType: row.contentType, name: row.name, isFolder: row.isFolder)
  }

  init(contentType: String, name: String, isFolder: Bool) {
    self = Self.classify(contentType: contentType, name: name, isFolder: isFolder)
  }

  private static let archiveTypes: Set<String> = [
    "application/zip", "application/gzip", "application/x-tar", "application/x-7z-compressed",
    "application/vnd.rar", "application/x-bzip2",
  ]
  private static let archiveExtensions: Set<String> = ["zip", "gz", "tgz", "tar", "7z", "rar", "bz2"]
  private static let documentMarkers = ["wordprocessingml", "msword", "opendocument.text", "apple.pages", "rtf"]
  private static let sheetMarkers = ["spreadsheetml", "ms-excel", "opendocument.spreadsheet", "apple.numbers"]
  private static let slidesMarkers = [
    "presentationml", "ms-powerpoint", "opendocument.presentation", "apple.keynote",
  ]
  private static let codeTypes: Set<String> = [
    "text/javascript", "text/typescript", "text/css", "text/html", "text/x-python",
    "text/x-shellscript", "application/json", "application/xml", "application/yaml",
    "application/sql", "application/javascript",
  ]
  private static let codeExtensions: Set<String> = [
    "js", "ts", "tsx", "jsx", "py", "sh", "sql", "json", "xml", "yaml", "yml", "css", "html",
  ]

  private static func classify(contentType: String, name: String, isFolder: Bool) -> DriveFileKind {
    if isFolder { return .folder }
    let type = contentType.lowercased()
    let ext = DriveIcons.extension(of: name)
    if type.hasPrefix("image/") { return .image }
    if type.hasPrefix("audio/") { return .audio }
    if type.hasPrefix("video/") { return .video }
    if type == "application/pdf" { return .pdf }
    if archiveTypes.contains(type) || archiveExtensions.contains(ext) { return .archive }
    if documentMarkers.contains(where: type.contains) { return .document }
    if sheetMarkers.contains(where: type.contains) || type == "text/csv" { return .sheet }
    if slidesMarkers.contains(where: type.contains) { return .slides }
    if codeTypes.contains(type) || codeExtensions.contains(ext) { return .code }
    if type.hasPrefix("text/") { return .text }
    return .file
  }

  var symbol: String {
    switch self {
    case .folder: "folder.fill"
    case .image: "photo"
    case .audio: "waveform"
    case .video: "film"
    case .pdf: "doc.richtext"
    case .text: "doc.plaintext"
    case .code: "chevron.left.forwardslash.chevron.right"
    case .archive: "doc.zipper"
    case .document: "doc.text"
    case .sheet: "tablecells"
    case .slides: "rectangle.on.rectangle"
    case .file: "doc"
    }
  }

  /// A hue per kind from the label palette, as the console's listing; folders carry the accent,
  /// plain files stay quiet.
  var tint: Color {
    switch self {
    case .folder: Theme.accent
    case .image: Theme.label(.violet)
    case .audio: Theme.label(.pink)
    case .video: Theme.label(.orange)
    case .pdf: Theme.red
    case .text, .archive, .file: Theme.subtle
    case .code: Theme.label(.teal)
    case .document: Theme.label(.blue)
    case .sheet: Theme.label(.green)
    case .slides: Theme.amber
    }
  }

  /// The soft fill of the kind's tile, from the same palette as its tint.
  var fill: Color {
    switch self {
    case .folder: Theme.accentSoft
    case .image: Theme.labelSoft(.violet)
    case .audio: Theme.labelSoft(.pink)
    case .video: Theme.labelSoft(.orange)
    case .pdf: Theme.redSoft
    case .text, .archive, .file: Theme.labelSoft(.gray)
    case .code: Theme.labelSoft(.teal)
    case .document: Theme.labelSoft(.blue)
    case .sheet: Theme.labelSoft(.green)
    case .slides: Theme.amberSoft
    }
  }

  var label: String {
    switch self {
    case .folder: "Folder"
    case .image: "Image"
    case .audio: "Audio"
    case .video: "Video"
    case .pdf: "PDF"
    case .text: "Text"
    case .code: "Code"
    case .archive: "Archive"
    case .document: "Document"
    case .sheet: "Spreadsheet"
    case .slides: "Presentation"
    case .file: "File"
    }
  }
}

enum DriveIcons {
  /// "report.pdf" gives "pdf"; "notes" and ".env" give "", as the console's `extensionOf`.
  static func `extension`(of name: String) -> String {
    guard let dot = name.lastIndex(of: "."), dot > name.startIndex else { return "" }
    let ext = name[name.index(after: dot)...]
    return ext.isEmpty ? "" : ext.lowercased()
  }
}

extension DriveView {
  /// The views the root offers, in the sidebar's order.
  static let picks: [DriveView] = [.mine, .shared, .recent, .starred, .trash]

  var title: String {
    switch self {
    case .mine: "My Drive"
    case .shared: "Shared with me"
    case .recent: "Recent"
    case .starred: "Starred"
    case .trash: "Trash"
    case .other(let raw): raw.capitalized
    }
  }

  var symbol: String {
    switch self {
    case .mine: "folder"
    case .shared: "person.2"
    case .recent: "clock"
    case .starred: "star"
    case .trash: "trash"
    case .other: "folder"
    }
  }
}

extension DriveRole {
  var title: String {
    switch self {
    case .owner: "Owner"
    case .editor: "Can edit"
    case .viewer: "Can view"
    case .other(let raw): raw.capitalized
    }
  }
}
