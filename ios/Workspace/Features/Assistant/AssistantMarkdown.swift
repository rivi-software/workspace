import Foundation
import SwiftUI

/// The answer's Markdown as rows a `Text` can show: paragraphs split on blank lines, each line a
/// bullet, a numbered item, a heading or running text, with the inline syntax (bold, links, code)
/// read by Foundation. Foundation's full parser reads lists and headings into intents `Text` does
/// not draw, so the block structure is read here first.
enum AssistantMarkdown {
  struct Paragraph: Identifiable {
    let id: Int
    var lines: [Line]
  }

  struct Line: Identifiable {
    enum Kind {
      case text
      case bullet
      case numbered(String)
      case heading
    }

    let id: Int
    var kind: Kind
    var content: AttributedString
  }

  static func paragraphs(_ markdown: String) -> [Paragraph] {
    var builder = Builder()
    for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
      let line = raw.trimmingCharacters(in: .whitespaces)
      if line.isEmpty {
        builder.endParagraph()
      } else if line.hasPrefix("```") {
        builder.endRunningText()
      } else if let item = bulletItem(line) {
        builder.add(.bullet, inline(item))
      } else if let (number, item) = numberedItem(line) {
        builder.add(.numbered(number), inline(item))
      } else if let heading = headingText(line) {
        builder.add(.heading, inline(heading))
      } else {
        builder.running.append(line)
      }
    }
    builder.endParagraph()
    return builder.paragraphs
  }

  /// The inline syntax read in full, falling back to the inline-only reading, then the words as
  /// they are, when the parser refuses them.
  static func inline(_ markdown: String) -> AttributedString {
    let full = AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
    if let parsed = try? AttributedString(markdown: markdown, options: full) { return parsed }
    let inlineOnly = AttributedString.MarkdownParsingOptions(
      interpretedSyntax: .inlineOnlyPreservingWhitespace)
    if let parsed = try? AttributedString(markdown: markdown, options: inlineOnly) { return parsed }
    return AttributedString(markdown)
  }

  private struct Builder {
    var paragraphs: [Paragraph] = []
    var lines: [Line] = []
    var running: [String] = []
    private var nextLineId = 0

    mutating func add(_ kind: Line.Kind, _ content: AttributedString) {
      endRunningText()
      lines.append(Line(id: nextLineId, kind: kind, content: content))
      nextLineId += 1
    }

    /// Consecutive plain lines are one paragraph of text.
    mutating func endRunningText() {
      guard !running.isEmpty else { return }
      let text = running.joined(separator: "\n")
      running.removeAll()
      add(.text, inline(text))
    }

    mutating func endParagraph() {
      endRunningText()
      guard !lines.isEmpty else { return }
      paragraphs.append(Paragraph(id: paragraphs.count, lines: lines))
      lines.removeAll()
    }
  }

  private static func bulletItem(_ line: String) -> String? {
    for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
      return String(line.dropFirst(marker.count))
    }
    return nil
  }

  private static func numberedItem(_ line: String) -> (String, String)? {
    let digits = line.prefix { $0.isNumber }
    guard !digits.isEmpty, digits.count <= 3 else { return nil }
    let rest = line.dropFirst(digits.count)
    guard let mark = rest.first, mark == "." || mark == ")", rest.dropFirst().first == " " else {
      return nil
    }
    return (String(digits), String(rest.dropFirst(2)))
  }

  private static func headingText(_ line: String) -> String? {
    let hashes = line.prefix { $0 == "#" }
    guard (1...6).contains(hashes.count), line.dropFirst(hashes.count).first == " " else { return nil }
    return String(line.dropFirst(hashes.count + 1))
  }
}

/// An answer's text as paragraphs, with bullets and numbers drawn and links tappable.
struct AssistantMarkdownText: View {
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(AssistantMarkdown.paragraphs(text)) { paragraph in
        VStack(alignment: .leading, spacing: 4) {
          ForEach(paragraph.lines) { line in
            row(line)
          }
        }
      }
    }
    .textSelection(.enabled)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func row(_ line: AssistantMarkdown.Line) -> some View {
    switch line.kind {
    case .text:
      Text(line.content)
    case .bullet:
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("•")
        Text(line.content)
      }
    case .numbered(let number):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text("\(number).")
          .monospacedDigit()
        Text(line.content)
      }
    case .heading:
      Text(line.content)
        .font(.headline)
    }
  }
}
