import SwiftUI
import WorkspaceKit

extension AssistantTool {
  /// The step's line while it runs.
  var runningLabel: String {
    switch self {
    case .searchMail: "Searching mail…"
    case .readConversation: "Reading a conversation…"
    case .searchDrive: "Searching Drive…"
    case .readFile: "Reading a file…"
    case .createDraft: "Preparing a draft…"
    case .other: "Working on it…"
    }
  }

  var symbol: String {
    switch self {
    case .searchMail: "magnifyingglass"
    case .readConversation: "envelope.open"
    case .searchDrive: "folder"
    case .readFile: "doc.text"
    case .createDraft: "square.and.pencil"
    case .other: "sparkles"
    }
  }
}

/// One message: the person's as a bubble on the right, the assistant's as text and step pills
/// on the left.
struct AssistantEntryView: View {
  let entry: AssistantEntry

  var body: some View {
    switch entry.role {
    case .user:
      AssistantBubble(text: entry.text)
    case .assistant, .other:
      GlassGroup(spacing: 8) {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(entry.blocks) { block in
            switch block {
            case .text(_, let text):
              AssistantMarkdownText(text: text)
            case .step(let step):
              AssistantStepPill(step: step)
            }
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

/// The person's words, in the accent tint.
struct AssistantBubble: View {
  let text: String
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    Text(text)
      .foregroundStyle(colorScheme == .dark ? Theme.ink : .white)
      .textSelection(.enabled)
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Theme.accent, in: .rect(cornerRadius: 18))
      .frame(maxWidth: .infinity, alignment: .trailing)
      .padding(.leading, 48)
      .accessibilityLabel("You said: \(text)")
  }
}

/// A tool's step as a small glass pill, with the input's one line behind a tap.
struct AssistantStepPill: View {
  let step: AssistantStep
  @State private var expanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        withAnimation(.snappy) { expanded.toggle() }
      } label: {
        HStack(spacing: 6) {
          if step.running {
            ProgressView()
              .controlSize(.mini)
          } else {
            Image(systemName: step.tool.symbol)
          }
          Text(step.running ? step.tool.runningLabel : step.tool.stepLabel)
          if step.summary != nil {
            Image(systemName: "chevron.down")
              .font(.caption2.weight(.semibold))
              .rotationEffect(expanded ? .degrees(180) : .zero)
          }
        }
        .font(.subheadline.weight(.medium))
      }
      .buttonStyle(.glass)
      .controlSize(.small)
      .accessibilityHint(step.summary == nil ? "" : "Shows what the step looked for")
      if expanded, let summary = step.summary {
        Text(summary)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .padding(.leading, 14)
      }
    }
  }
}

/// The RIVI mark's bars as a level meter, moving until the answer's first words.
struct AssistantThinkingDots: View {
  var body: some View {
    SignalMeter(height: 18, active: true)
      .padding(.vertical, 6)
      .accessibilityElement()
      .accessibilityLabel("Thinking")
  }
}

/// What the assistant is and what to ask, under the mark's bars at rest: the empty list's
/// opening and a new conversation's.
struct AssistantIntro: View {
  var alignment: HorizontalAlignment = .leading

  var body: some View {
    VStack(alignment: alignment, spacing: 10) {
      SignalMeter(height: alignment == .center ? 44 : 30, active: false, bars: Theme.foreground)
        .padding(.bottom, 6)
      Text("Ask the assistant")
        .font(.title2.weight(.bold))
      Text("It searches your mail and Drive, reads what it finds and answers with links.")
        .font(.body)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(alignment == .center ? .center : .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: Alignment(horizontal: alignment, vertical: .center))
    .accessibilityElement(children: .combine)
  }
}

/// The opening questions as glass chips; a tap asks one.
struct AssistantSuggestionChips: View {
  let suggestions: [String]
  var alignment: HorizontalAlignment = .leading
  let select: (String) -> Void

  var body: some View {
    GlassGroup(spacing: 6) {
      VStack(alignment: alignment, spacing: 10) {
        ForEach(suggestions.indices, id: \.self) { index in
          Button {
            select(suggestions[index])
          } label: {
            Label(suggestions[index], systemImage: "sparkles")
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
          }
          .buttonStyle(.glass)
        }
      }
      .frame(maxWidth: .infinity, alignment: Alignment(horizontal: alignment, vertical: .center))
    }
  }
}
