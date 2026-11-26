package software.rivi.workspace

import java.net.URLDecoder
import java.nio.charset.Charset

/**
 * The file name in a `Content-Disposition` header (RFC 6266), as a browser reads it: `filename*`,
 * the name in any language (RFC 8187), before `filename`, the plain one. The workspace sends both
 * (`attachment; filename="Café.pdf"; filename*=UTF-8''Caf%C3%A9.pdf`); Android's own
 * `URLUtil.guessFileName` reads neither from that header before Android 15, and names the file
 * after the last part of its URL, a file's id.
 */
object ContentDisposition {
  /** Path separators and control characters, which a file name in a folder cannot hold. */
  private val UNSAFE = Regex("""[/\\\p{Cntrl}]""")

  /**
   * Whether the header asks to show the file in place (`inline`) rather than save it. Every other
   * type, a missing header's included, is a file to save: RFC 6266 has a type it does not know
   * read as `attachment`.
   */
  fun isInline(header: String?): Boolean =
    header?.substringBefore(';')?.trim()?.equals("inline", ignoreCase = true) == true

  /** The header's file name, made one file in a folder; null when it names none. */
  fun fileName(header: String?): String? {
    val parameters = parameters(header ?: return null)
    val name = parameters["filename*"]?.let(::decodeExtended) ?: parameters["filename"]
    return name?.replace(UNSAFE, "_")?.trim()?.takeUnless { it.isEmpty() || it == "." || it == ".." }
  }

  /**
   * The parameters after the disposition type, by lowercase name, a quoted value unquoted; the
   * first of a name counts. A quoted value may hold a `;`.
   */
  private fun parameters(header: String): Map<String, String> {
    val parameters = mutableMapOf<String, String>()
    var at = header.indexOf(';') + 1
    while (at in 1 until header.length) {
      val equals = header.indexOf('=', at)
      val next = header.indexOf(';', at)
      if (equals < 0) break
      if (next in 0 until equals) {
        at = next + 1
        continue
      }
      val name = header.substring(at, equals).trim().lowercase()
      at = equals + 1
      while (at < header.length && header[at].isWhitespace()) at++
      val value = StringBuilder()
      if (at < header.length && header[at] == '"') {
        at++
        while (at < header.length && header[at] != '"') {
          if (header[at] == '\\' && at + 1 < header.length) at++
          value.append(header[at])
          at++
        }
        val end = header.indexOf(';', at)
        at = if (end < 0) header.length else end + 1
      } else {
        val end = header.indexOf(';', at).let { if (it < 0) header.length else it }
        value.append(header, at, end)
        at = end + 1
      }
      parameters.putIfAbsent(name, value.toString().trim())
    }
    return parameters
  }

  /** An RFC 8187 value, `charset'language'percent-encoded`; null when it is not one. */
  private fun decodeExtended(value: String): String? {
    val parts = value.split('\'', limit = 3)
    if (parts.size != 3) return null
    val (charset, _, encoded) = parts
    // URLDecoder reads a form's encoding, where "+" is a space; here it is itself. Some versions of
    // it look up the charset only at the first "%", so it is looked up first.
    return runCatching {
      URLDecoder.decode(encoded.replace("+", "%2B"), Charset.forName(charset).name())
    }.getOrNull()
  }
}
