import SwiftUI

// RIVI's two marks drawn from their geometry (`@rivi/brand` and `apps/workspace-mobile/icon`), so
// they follow the appearance and can move: Workspace's four module tiles with one lit, and the
// RIVI mark's five level bars with the middle one lit. One element lit in the signal green is
// the identity's grammar; the app spends it on what is live.

/// Workspace's symbol: four module tiles, one lit, on the mark's ink tile or straight on the page.
struct WorkspaceSymbol: View {
  var size: CGFloat = 40
  /// The lit tile: 0 top left, 1 top right, 2 bottom left, 3 bottom right.
  var lit: Int? = 0
  /// On the mark's tile, as the app icon; otherwise the modules alone in the page's tones.
  var tiled = true
  /// How many of the four tiles show, in reading order, for the entrance.
  var shown = 4

  private static let origins: [CGPoint] = [
    CGPoint(x: 9, y: 9), CGPoint(x: 21.5, y: 9), CGPoint(x: 9, y: 21.5), CGPoint(x: 21.5, y: 21.5),
  ]

  var body: some View {
    // The tiled symbol is drawn on the 40 grid; the bare one on the 22 the modules span.
    let grid: CGFloat = tiled ? 40 : 22
    let inset: CGFloat = tiled ? 0 : 9
    let unit = size / grid
    ZStack(alignment: .topLeading) {
      if tiled {
        RoundedRectangle(cornerRadius: 9 * unit, style: .continuous)
          .fill(Theme.markTile)
      }
      ForEach(0..<4, id: \.self) { index in
        let origin = Self.origins[index]
        RoundedRectangle(cornerRadius: 3 * unit, style: .continuous)
          .fill(color(index))
          .frame(width: 9.5 * unit, height: 9.5 * unit)
          .scaleEffect(index < shown ? 1 : 0.4)
          .opacity(index < shown ? 1 : 0)
          .offset(x: (origin.x - inset) * unit, y: (origin.y - inset) * unit)
      }
    }
    .frame(width: size, height: size, alignment: .topLeading)
    .accessibilityHidden(true)
  }

  private func color(_ index: Int) -> Color {
    if index == lit { return tiled ? Theme.markLit : Theme.accent }
    return tiled ? Theme.markInk : Theme.markUnlit
  }
}

/// The symbol with its lit tile walking round the four, clockwise, while something loads. With
/// Reduce Motion on it stays still and breathes instead.
struct WorkspaceLoader: View {
  var size: CGFloat = 26
  var tiled = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Clockwise from the top left: 0, 1, 3, 2.
  private static let walk = [0, 1, 3, 2]

  var body: some View {
    Group {
      if reduceMotion {
        WorkspaceSymbol(size: size, lit: 0, tiled: tiled)
          .phaseAnimator([1.0, 0.45]) { symbol, opacity in
            symbol.opacity(opacity)
          } animation: { _ in
            .easeInOut(duration: 0.9)
          }
      } else {
        PhaseAnimator(Self.walk) { lit in
          WorkspaceSymbol(size: size, lit: lit, tiled: tiled)
        } animation: { _ in
          .easeOut(duration: 0.22).delay(0.1)
        }
      }
    }
    .accessibilityElement()
    .accessibilityLabel("Loading")
    .accessibilityAddTraits(.updatesFrequently)
  }
}

/// The RIVI mark's five bars as a level meter: still, they are the mark; moving, the meter of
/// something at work (the Assistant thinking). The middle bar is lit.
struct SignalMeter: View {
  var height: CGFloat = 20
  var active = true
  /// The bars that are not lit: the page's ink for the mark at rest, quieter for the meter.
  var bars: Color = Theme.muted
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The mark's bar heights on its 40 grid, left to right (`MARK_BARS`).
  private static let rest: [CGFloat] = [8, 18, 26, 16, 8]
  private static let peak = 2

  var body: some View {
    if active && !reduceMotion {
      TimelineView(.animation) { context in
        bars(at: context.date.timeIntervalSinceReferenceDate)
      }
    } else {
      bars(at: nil)
    }
  }

  /// The bars at a moment: each swings between a third and all of its height at its own pace,
  /// so the meter reads as a signal rather than a wave.
  private func bars(at time: TimeInterval?) -> some View {
    let unit = height / 26
    return HStack(alignment: .center, spacing: 2.25 * unit) {
      ForEach(0..<5, id: \.self) { index in
        Capsule()
          .fill(index == Self.peak ? Theme.accent : bars)
          .frame(width: 3 * unit, height: Self.rest[index] * unit * level(index, time))
      }
    }
    .frame(height: height)
    .accessibilityHidden(true)
  }

  private func level(_ index: Int, _ time: TimeInterval?) -> CGFloat {
    guard let time else { return 1 }
    let speeds: [Double] = [5.1, 3.7, 4.4, 6.2, 4.8]
    let swing = (sin(time * speeds[index] + Double(index) * 1.3) + 1) / 2
    return CGFloat(0.35 + 0.65 * swing)
  }
}
