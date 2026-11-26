import SwiftUI

/// A person's initials on a disc whose hue follows their name, lighter on a light page and
/// darker on a dark one, as the console's `Avatar`.
struct AvatarView: View {
  let name: String
  var size: CGFloat = 32
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    Text(initials)
      .font(.system(size: size * 0.4, weight: .semibold, design: .rounded))
      .foregroundStyle(Color(hue: hue, saturation: 0.45, brightness: colorScheme == .dark ? 0.9 : 0.4))
      .frame(width: size, height: size)
      .background(
        Color(hue: hue, saturation: 0.35, brightness: colorScheme == .dark ? 0.3 : 0.95), in: .circle)
      .accessibilityLabel(name)
  }

  private var initials: String {
    let words = name.split(separator: " ").prefix(2)
    let letters = words.compactMap { $0.first.map(String.init) }
    return letters.isEmpty ? "?" : letters.joined().uppercased()
  }

  private var hue: Double {
    var hash: UInt32 = 5381
    for byte in name.utf8 { hash = hash &* 33 &+ UInt32(byte) }
    return Double(hash % 360) / 360
  }
}
