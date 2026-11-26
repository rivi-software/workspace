import SwiftUI

/// An image on its own, pinched to zoom and panned, double-tapped between fit and close.
struct DriveImageViewer: View {
  let image: UIImage
  let name: String
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var settledScale: CGFloat = 1

  private static let closest: CGFloat = 6
  private static let doubleTapScale: CGFloat = 2.5

  var body: some View {
    NavigationStack {
      GeometryReader { geometry in
        ScrollView([.horizontal, .vertical], showsIndicators: false) {
          Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .frame(width: geometry.size.width * scale, height: geometry.size.height * scale)
        }
        .defaultScrollAnchor(.center)
      }
      .background(Color.black.ignoresSafeArea())
      .gesture(
        MagnifyGesture()
          .onChanged { value in
            scale = min(max(settledScale * value.magnification, 1), Self.closest)
          }
          .onEnded { _ in
            settledScale = scale
          }
      )
      .onTapGesture(count: 2) {
        withAnimation(.snappy) {
          scale = scale > 1 ? 1 : Self.doubleTapScale
          settledScale = scale
        }
      }
      .navigationTitle(name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Done") { dismiss() }
        }
      }
      .accessibilityLabel(name)
    }
  }
}
