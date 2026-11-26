import SwiftUI
import UIKit
import WorkspaceKit

extension UIColor {
  convenience init(hex: UInt32) {
    self.init(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(uiColor: UIColor(hex: hex))
  }

  /// One color per appearance, as the console's tokens are two readings of one scale.
  init(light: UInt32, dark: UInt32) {
    self.init(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light)
      })
  }
}

/// The console's tokens (`apps/workspace/app/app.css`) as colors. Type is the system's: SF, not
/// the web's Inter. Text and fills read a semantic token, never a raw hue.
enum Theme {
  /// RIVI green: the deep green on light surfaces, the signal green on dark ones (the asset
  /// catalog's AccentColor, so it also tints the system's controls).
  static let accent = Color.accentColor
  /// The brand's signal green, as on the mark's peak and the dark accent.
  static let signal = Color(hex: 0x3BE0_8A)
  static let ink = Color(hex: 0x1F20_23)
  static let canvas = Color(light: 0xFCFC_FC, dark: 0x191A_1B)
  static let sidebar = Color(light: 0xF7F7_F8, dark: 0x1415_16)
  static let elevated = Color(light: 0xFFFF_FF, dark: 0x2223_26)
  static let selected = Color(light: 0xEBF3_EF, dark: 0x1C2A_24)
  static let border = Color(light: 0xE6E6_E9, dark: 0x292A_2F)
  static let foreground = Color(light: 0x1F20_23, dark: 0xE6E7_EA)
  static let muted = Color(light: 0x5F63_6C, dark: 0x9A9E_A7)
  static let subtle = Color(light: 0x6F73_7C, dark: 0x868A_94)
  static let faint = Color(light: 0xB4B7_BE, dark: 0x4D50_58)
  static let accentSoft = Color(light: 0xE7FB_F1, dark: 0x1E36_2B)
  static let amber = Color(light: 0xD980_0C, dark: 0xF2A3_3A)
  static let amberSoft = Color(light: 0xFBEF_DC, dark: 0x3A2A_12)
  static let red = Color(light: 0xD845_3D, dark: 0xEB57_57)
  static let redSoft = Color(light: 0xFBE6_E4, dark: 0x3C1F_1F)
  static let star = Color(light: 0xE2A4_16, dark: 0xF2C1_4E)
  /// Text and symbols on the accent fill: white on the deep green, ink on the signal green.
  static let onAccent = Color(light: 0xFFFF_FF, dark: 0x0809_0A)
  /// The RIVI mark's tile: ink in the light reading, near white in the dark one.
  static let markTile = Color(light: 0x1517_1A, dark: 0xF7F8_F8)
  /// What sits on the mark's tile: paper on the ink tile, ink on the paper one.
  static let markInk = Color(light: 0xF5F6_F7, dark: 0x0809_0A)
  /// The mark's lit element: the signal green on ink, the cue green on paper.
  static let markLit = Color(light: 0x3BE0_8A, dark: 0x0E9F_55)
  /// An element of the mark that is not lit, drawn on the page rather than on its tile.
  static let markUnlit = Color(light: 0xD4D4_D9, dark: 0x3739_3F)

  /// The corner of a tile as a share of its side: the mark's 9 on its 40 grid. Tiles that echo
  /// the mark (a file's kind, the symbol) round their corners by it.
  static let tileCornerRatio: CGFloat = 9 / 40

  static func tileCorner(_ side: CGFloat) -> CGFloat { side * tileCornerRatio }

  /// A label's text color.
  static func label(_ color: LabelColor) -> Color {
    switch color {
    case .gray: Color(light: 0x5F63_6C, dark: 0xA3A7_B0)
    case .red: Color(light: 0xD845_3D, dark: 0xEB57_57)
    case .orange: Color(light: 0xD966_1A, dark: 0xF08A_4B)
    case .amber: Color(light: 0xC27A_0A, dark: 0xF2A3_3A)
    case .green: Color(light: 0x0A7F_43, dark: 0x3BE0_8A)
    case .teal: Color(light: 0x0F8F_85, dark: 0x2FC4_B6)
    case .blue: Color(light: 0x2F6F_D1, dark: 0x6AA6_F5)
    case .violet: Color(light: 0x7C4F_E0, dark: 0xA98C_F8)
    case .pink: Color(light: 0xC937_8F, dark: 0xEF7F_C5)
    case .other: label(.gray)
    }
  }

  /// The soft fill behind a label's text.
  static func labelSoft(_ color: LabelColor) -> Color {
    switch color {
    case .gray: Color(light: 0xEEF0_F3, dark: 0x2A2C_31)
    case .red: Color(light: 0xFBE6_E4, dark: 0x3C1F_1F)
    case .orange: Color(light: 0xFDEA_DC, dark: 0x3A25_15)
    case .amber: Color(light: 0xFBEF_DC, dark: 0x3A2A_12)
    case .green: Color(light: 0xE7FB_F1, dark: 0x1E36_2B)
    case .teal: Color(light: 0xDCF3_F1, dark: 0x1632_30)
    case .blue: Color(light: 0xE4EE_FB, dark: 0x1A2A_40)
    case .violet: Color(light: 0xEFE8_FE, dark: 0x2A21_40)
    case .pink: Color(light: 0xFBE4_F2, dark: 0x3A1E_30)
    case .other: labelSoft(.gray)
    }
  }
}
