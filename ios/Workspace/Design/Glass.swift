import SwiftUI

// Liquid Glass pieces. The system's bars, tabs and sheets are glass by themselves; these are for
// what floats over content. Group neighbors in `GlassGroup` so their glass merges, and never put
// glass on glass. A screen's one primary action uses `.prominentAction()`.

/// A round glass button with one symbol, for a control floating over content (compose, filter).
/// The screen's one primary action is `prominent`: larger, in the accent, as `GlassActionLabel`.
struct GlassIconButton: View {
  let systemImage: String
  /// What VoiceOver reads.
  let label: String
  var prominent = false
  let action: () -> Void

  var body: some View {
    if prominent {
      Button(action: action) {
        GlassActionLabel(systemImage: systemImage)
      }
      .buttonStyle(.glassProminent)
      .buttonBorderShape(.circle)
      .accessibilityLabel(label)
    } else {
      Button(action: action) {
        Image(systemName: systemImage)
          .font(.body.weight(.semibold))
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.glass)
      .accessibilityLabel(label)
    }
  }
}

/// The face of a screen's floating primary action (new message, new task): one symbol on the
/// accent, in the color that reads on it in either appearance. Also a `Menu`'s label.
struct GlassActionLabel: View {
  let systemImage: String

  var body: some View {
    Image(systemName: systemImage)
      .font(.title3.weight(.semibold))
      .foregroundStyle(Theme.onAccent)
      .frame(width: 52, height: 52)
  }
}

/// The prominent glass with its label in the on-accent color while the button can act; a
/// disabled one keeps the system's dimmed label, which reads on the grayed glass.
private struct ProminentAction: ViewModifier {
  @Environment(\.isEnabled) private var isEnabled

  func body(content: Content) -> some View {
    content
      .buttonStyle(.glassProminent)
      .foregroundStyle(isEnabled ? AnyShapeStyle(Theme.onAccent) : AnyShapeStyle(.secondary))
  }
}

extension View {
  /// A screen's one primary action: the prominent glass in the accent, its words and symbols in
  /// the color that reads on the accent (white on the deep green, ink on the signal green).
  func prominentAction() -> some View {
    modifier(ProminentAction())
  }

  /// Where a screen's floating primary action sits, bottom trailing over its content: the
  /// Assistant's new conversation in its sheet. The tabs make things from the create menu at the
  /// top right instead (`CreateMenu`).
  func floatingAction<Action: View>(@ViewBuilder _ action: () -> Action) -> some View {
    overlay(alignment: .bottomTrailing) {
      action()
        .padding(.trailing, 20)
        .padding(.bottom, 16)
    }
  }
}

/// A short status in a glass capsule over content ("3 selected", "Offline").
struct GlassPillLabel: View {
  let text: String
  var systemImage: String?

  var body: some View {
    HStack(spacing: 6) {
      if let systemImage {
        Image(systemName: systemImage)
      }
      Text(text)
    }
    .font(.subheadline.weight(.medium))
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .glassEffect(.regular, in: .capsule)
  }
}

/// A rounded glass card for content that floats over a scroll view or a map.
struct GlassCard<Content: View>: View {
  var cornerRadius: CGFloat = 20
  @ViewBuilder let content: Content

  var body: some View {
    content
      .padding(16)
      .glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
  }
}

/// Grouped glass controls (a bottom action bar): one container, so neighbors blend as they move.
struct GlassGroup<Content: View>: View {
  var spacing: CGFloat = 12
  @ViewBuilder let content: Content

  var body: some View {
    GlassEffectContainer(spacing: spacing) {
      content
    }
  }
}
