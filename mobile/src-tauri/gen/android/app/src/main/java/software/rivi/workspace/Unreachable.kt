package software.rivi.workspace

import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Message
import android.view.KeyEvent
import android.webkit.ClientCertRequest
import android.webkit.HttpAuthHandler
import android.webkit.RenderProcessGoneDetail
import android.webkit.SafeBrowsingResponse
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi

/**
 * The web view's client: wry's own ([wry]), which serves the start page and asks the shell about
 * every navigation, with one change. When a page fails to load (the workspace cannot be reached:
 * no network, a name that does not resolve, a server that does not answer), the Android System
 * WebView would show its own "Webpage not available" page in its place. This sends the web view
 * back to the start page instead, which says it cannot reach RIVI Workspace and offers to try
 * again, as WebKit on an iPhone keeps the start page (src/start.js reads `unreachable`, the address
 * that failed, and tries it again if it is the workspace's).
 *
 * The failed load and everything before it leave the web view's history once the start page is
 * there, so the back button leaves the app from it, as from a fresh start: going back to the failed
 * address would fail again and bring the start page back.
 *
 * Every other call goes to wry's client unchanged.
 */
class Unreachable(private val wry: WebViewClient) : WebViewClient() {
  /** Whether the history goes once the start page has loaded. */
  private var forgetHistory = false

  override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
    // A frame's failure stays in the frame. A failure on the app's own pages is wry's: it loads
    // again a redirect to them that the web view lost (RustWebViewClient.kt), and the start page
    // failing would bring itself back. A load stopped for a download or another load has not
    // failed.
    val stopped = error.description?.toString() == ABORTED
    if (!request.isForMainFrame || request.url.host == START_PAGE.host || stopped) {
      wry.onReceivedError(view, request, error)
      return
    }
    view.stopLoading()
    forgetHistory = true
    view.loadUrl(
      START_PAGE.buildUpon()
        .appendQueryParameter("unreachable", request.url.toString())
        .build()
        .toString()
    )
  }

  override fun onPageFinished(view: WebView, url: String) {
    wry.onPageFinished(view, url)
    if (forgetHistory && Uri.parse(url).host == START_PAGE.host) {
      forgetHistory = false
      view.clearHistory()
    }
  }

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
    wry.shouldOverrideUrlLoading(view, request)

  override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
    wry.onPageStarted(view, url, favicon)

  override fun onLoadResource(view: WebView, url: String) = wry.onLoadResource(view, url)

  override fun onPageCommitVisible(view: WebView, url: String) = wry.onPageCommitVisible(view, url)

  override fun shouldInterceptRequest(
    view: WebView,
    request: WebResourceRequest,
  ): WebResourceResponse? = wry.shouldInterceptRequest(view, request)

  override fun onReceivedHttpError(
    view: WebView,
    request: WebResourceRequest,
    errorResponse: WebResourceResponse,
  ) = wry.onReceivedHttpError(view, request, errorResponse)

  override fun onFormResubmission(view: WebView, dontResend: Message, resend: Message) =
    wry.onFormResubmission(view, dontResend, resend)

  override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
    wry.doUpdateVisitedHistory(view, url, isReload)

  override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) =
    wry.onReceivedSslError(view, handler, error)

  override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) =
    wry.onReceivedClientCertRequest(view, request)

  override fun onReceivedHttpAuthRequest(
    view: WebView,
    handler: HttpAuthHandler,
    host: String,
    realm: String,
  ) = wry.onReceivedHttpAuthRequest(view, handler, host, realm)

  override fun shouldOverrideKeyEvent(view: WebView, event: KeyEvent): Boolean =
    wry.shouldOverrideKeyEvent(view, event)

  override fun onUnhandledKeyEvent(view: WebView, event: KeyEvent) =
    wry.onUnhandledKeyEvent(view, event)

  override fun onScaleChanged(view: WebView, oldScale: Float, newScale: Float) =
    wry.onScaleChanged(view, oldScale, newScale)

  override fun onReceivedLoginRequest(view: WebView, realm: String, account: String?, args: String) =
    wry.onReceivedLoginRequest(view, realm, account, args)

  @RequiresApi(Build.VERSION_CODES.O)
  override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean =
    wry.onRenderProcessGone(view, detail)

  @RequiresApi(Build.VERSION_CODES.O_MR1)
  override fun onSafeBrowsingHit(
    view: WebView,
    request: WebResourceRequest,
    threatType: Int,
    callback: SafeBrowsingResponse,
  ) = wry.onSafeBrowsingHit(view, request, threatType, callback)

  companion object {
    /**
     * The start page, src/index.html, as the app serves it in the Android System WebView
     * (`ON_START_PAGE` in src-tauri/src/window.rs).
     */
    val START_PAGE: Uri = Uri.parse("http://tauri.localhost/index.html")

    /** What the web view reports for a load that was stopped rather than failed. */
    private const val ABORTED = "net::ERR_ABORTED"
  }
}
