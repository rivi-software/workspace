package software.rivi.workspace

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.URLUtil
import android.widget.Toast

/**
 * Hands a download to the system's download manager, which saves it in the phone's Downloads folder
 * and shows its progress and the finished file in a notification. The Android System WebView only
 * tells its listener about a download, and wry sets none, so without this a tap on Download in
 * Drive or on an attachment did nothing.
 *
 * The download manager fetches the file outside the web view, so it carries the web view's cookies
 * for the address, which hold the workspace's session, and its user agent. Before Android 10 a
 * file in the shared Downloads folder needs the storage permission, which the app does not ask
 * for: there the file goes to the app's own Downloads folder, and the notification and the system's
 * Downloads list still open it.
 */
class Downloads(private val context: Context) : DownloadListener {
  override fun onDownloadStart(
    url: String,
    userAgent: String?,
    contentDisposition: String?,
    mimetype: String?,
    contentLength: Long,
  ) {
    // The workspace serves a file to show in place `inline` (a PDF in Drive's preview frame, a file
    // opened in a page of its own), and every file the person asks to download as an `attachment`
    // (`?download=1`). The web view hands this listener any file it cannot show, a frame's too,
    // without saying which frame: saving an inline one would put a copy in Downloads each time a
    // PDF's preview opens. The workspace offers no PDF in place in this app: Drive shows
    // its no-preview card with Download in place of a PDF's frame, and no Open in a new tab for one.
    if (ContentDisposition.isInline(contentDisposition)) return
    val uri = Uri.parse(url)
    // The download manager fetches HTTP alone. The workspace serves every download from an
    // address; a `blob:` or `data:` one would need the page to hand its bytes over.
    if (uri.scheme != "https" && uri.scheme != "http") return
    val name = ContentDisposition.fileName(contentDisposition)
      ?: URLUtil.guessFileName(url, contentDisposition, mimetype)
    try {
      val request = DownloadManager.Request(uri)
        .setTitle(name)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
      if (!mimetype.isNullOrBlank()) request.setMimeType(mimetype)
      if (!userAgent.isNullOrBlank()) request.addRequestHeader("User-Agent", userAgent)
      CookieManager.getInstance().getCookie(url)?.let { request.addRequestHeader("Cookie", it) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
      } else {
        request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
      }
      context.getSystemService(DownloadManager::class.java).enqueue(request)
      toast(R.string.download_started, name)
    } catch (_: RuntimeException) {
      // The download manager is turned off, or the Downloads folder is missing.
      toast(R.string.download_failed, name)
    }
  }

  private fun toast(message: Int, name: String) {
    Toast.makeText(context, context.getString(message, name), Toast.LENGTH_SHORT).show()
  }
}
