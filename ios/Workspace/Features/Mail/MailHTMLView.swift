import SwiftUI
import WebKit

/// A message's HTML document in a web view sized to its content: the document loads once, a link
/// opens in the browser, and the height follows the document as it settles.
struct MailHTMLView: UIViewRepresentable {
  let request: URLRequest
  @Binding var height: CGFloat
  @Environment(\.openURL) private var openURL

  func makeCoordinator() -> Coordinator {
    Coordinator()
  }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(context.coordinator, name: Coordinator.sizeMessage)
    configuration.userContentController.addUserScript(
      WKUserScript(source: Coordinator.sizeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.scrollView.isScrollEnabled = false
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.isOpaque = false
    webView.backgroundColor = .clear
    webView.scrollView.backgroundColor = .clear
    context.coordinator.update(height: $height, openURL: openURL)
    context.coordinator.load(request, in: webView)
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(height: $height, openURL: openURL)
    context.coordinator.load(request, in: webView)
  }

  static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
    webView.configuration.userContentController.removeScriptMessageHandler(forName: Coordinator.sizeMessage)
    webView.navigationDelegate = nil
    coordinator.cancel()
  }

  @MainActor
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    static let sizeMessage = "size"
    /// Posts the document's height as it changes, and once it has loaded.
    static let sizeScript = """
      (function () {
        var post = function () {
          window.webkit.messageHandlers.size.postMessage(document.documentElement.scrollHeight);
        };
        if (window.ResizeObserver) {
          new ResizeObserver(post).observe(document.documentElement);
          if (document.body) { new ResizeObserver(post).observe(document.body); }
        }
        window.addEventListener('load', post);
        post();
      })();
      """
    /// Images still arriving after `didFinish` change the height; measure again a few times.
    private static let remeasureDelays: [Double] = [0.3, 1, 2.5]

    private var height: Binding<CGFloat>?
    private var openURL: OpenURLAction?
    private var loaded: URLRequest?
    private var remeasure: Task<Void, Never>?

    func update(height: Binding<CGFloat>, openURL: OpenURLAction) {
      self.height = height
      self.openURL = openURL
    }

    /// Loads the document once; the same request again is left alone.
    func load(_ request: URLRequest, in webView: WKWebView) {
      guard loaded != request else { return }
      loaded = request
      webView.load(request)
    }

    func cancel() {
      remeasure?.cancel()
    }

    // MARK: WKNavigationDelegate

    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction
    ) async -> WKNavigationActionPolicy {
      guard let url = navigationAction.request.url else { return .cancel }
      if navigationAction.navigationType == .linkActivated || navigationAction.targetFrame == nil {
        openURL?(url)
        return .cancel
      }
      // The document's own load, and nothing else.
      if navigationAction.navigationType == .other, url == loaded?.url {
        return .allow
      }
      return .cancel
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      measure(webView)
      remeasure?.cancel()
      remeasure = Task { [weak self, weak webView] in
        for delay in Self.remeasureDelays {
          try? await Task.sleep(for: .seconds(delay))
          guard !Task.isCancelled, let self, let webView else { return }
          self.measure(webView)
        }
      }
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard message.name == Self.sizeMessage, let measured = message.body as? Double else { return }
      set(measured)
    }

    private func measure(_ webView: WKWebView) {
      webView.evaluateJavaScript("document.documentElement.scrollHeight") { [weak self] result, _ in
        guard let measured = result as? Double else { return }
        self?.set(measured)
      }
    }

    private func set(_ measured: Double) {
      guard measured.isFinite, measured > 0, let height else { return }
      let rounded = ceil(measured)
      if abs(height.wrappedValue - rounded) >= 1 {
        height.wrappedValue = rounded
      }
    }
  }
}
