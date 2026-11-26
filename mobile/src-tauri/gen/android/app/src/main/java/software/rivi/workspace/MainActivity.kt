package software.rivi.workspace

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The app's one activity. TauriActivity opens the web view on the start page (src/index.html),
 * which goes on to the workspace, and sends the back button back through the web view's history.
 *
 * The web view keeps clear of the status bar, the navigation bar, a display cutout and the keyboard
 * here: the Android System WebView tells a page nothing about them, unlike WebKit on an iPhone, so
 * the page's `safe-area-inset-*` are 0 on Android and the insets become the web view's margins in
 * the window, whose background is the workspace's canvas colour of the phone's reading
 * (res/values/themes.xml, res/values/colors.xml). Margins, not padding: a WebView draws its page
 * over its padding.
 *
 * A download goes to the system's download manager (Downloads.kt), and a page that fails to load
 * brings the start page back, which says it cannot reach the workspace (Unreachable.kt): wry gives
 * the Android System WebView neither.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // The web view's own agent, which names the real Android and WebView, with the app's name and
    // version after it, so the workspace can tell the app from Chrome (app/lib/mobile-app.ts).
    webView.settings.userAgentString =
      "${webView.settings.userAgentString} RIVIWorkspaceApp/${BuildConfig.VERSION_NAME}"
    webView.setBackgroundColor(getColor(R.color.canvas))
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime()
      )
      val params = view.layoutParams
      if (params is ViewGroup.MarginLayoutParams) {
        params.setMargins(bars.left, bars.top, bars.right, bars.bottom)
        view.layoutParams = params
      }
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(webView)
    webView.setDownloadListener(Downloads(this))
    // wry sets its client after this call, in the same turn of the main thread, so it is wrapped on
    // the next turn, before the start page sends the web view on to the workspace. Before Android 8
    // an older Android System WebView cannot hand the client over, and shows its own error page.
    webView.post {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.GET_WEB_VIEW_CLIENT)) {
        val client = WebViewCompat.getWebViewClient(webView)
        if (client !is Unreachable) webView.webViewClient = Unreachable(client)
      }
    }
  }
}
