package software.rivi.workspace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ContentDispositionTest {
  @Test
  fun theEncodedNameWinsAsTheWorkspaceSendsBoth() {
    // app/lib/drive/serve.server.ts and routes/api/files.$id.ts
    assertEquals(
      "Café plan.pdf",
      ContentDisposition.fileName(
        "attachment; filename=\"Café plan.pdf\"; filename*=UTF-8''Caf%C3%A9%20plan.pdf"
      )
    )
    assertEquals(
      "Café plan.pdf",
      ContentDisposition.fileName(
        "attachment; filename*=UTF-8''Caf%C3%A9%20plan.pdf; filename=\"Cafe plan.pdf\""
      )
    )
  }

  @Test
  fun aPlainNameIsReadQuotedOrNot() {
    assertEquals("01J9.eml", ContentDisposition.fileName("attachment; filename=\"01J9.eml\""))
    assertEquals("report.pdf", ContentDisposition.fileName("attachment; filename=report.pdf"))
    assertEquals("report.pdf", ContentDisposition.fileName("attachment;FILENAME = \"report.pdf\" "))
    assertEquals("a;b \"c\".txt", ContentDisposition.fileName("attachment; filename=\"a;b \\\"c\\\".txt\""))
  }

  @Test
  fun anEncodedNameKeepsItsPlusSignsAndReadsItsCharset() {
    // RFC 8187 reads "+" as itself, where a form's encoding would read a space.
    assertEquals("C++ notes.txt", ContentDisposition.fileName("attachment; filename*=UTF-8''C++%20notes.txt"))
    assertEquals("£ rates.csv", ContentDisposition.fileName("attachment; filename*=iso-8859-1'en'%A3%20rates.csv"))
  }

  @Test
  fun aBrokenEncodedNameFallsBackToThePlainOne() {
    assertEquals(
      "plan.pdf",
      ContentDisposition.fileName("attachment; filename*=UTF-8''plan%ZZ.pdf; filename=\"plan.pdf\"")
    )
    assertEquals(
      "plan.pdf",
      ContentDisposition.fileName("attachment; filename*=no-such-charset''other.pdf; filename=plan.pdf")
    )
    assertEquals("plan.pdf", ContentDisposition.fileName("attachment; filename*=other.pdf; filename=plan.pdf"))
  }

  @Test
  fun aNameStaysOneFileInTheDownloadsFolder() {
    assertEquals(".._.._etc_passwd", ContentDisposition.fileName("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd"))
    assertEquals("a_b_c", ContentDisposition.fileName("attachment; filename=\"a\\\\b/c\""))
    assertEquals("line_break", ContentDisposition.fileName("attachment; filename*=UTF-8''line%0Abreak"))
    assertNull(ContentDisposition.fileName("attachment; filename=\"..\""))
    assertNull(ContentDisposition.fileName("attachment; filename=\"  \""))
  }

  @Test
  fun aFileToShowInPlaceIsInlineAndEveryOtherIsToSave() {
    // app/lib/drive/serve.server.ts: a preview inline, `?download=1` an attachment.
    assertTrue(ContentDisposition.isInline("inline; filename=\"plan.pdf\"; filename*=UTF-8''plan.pdf"))
    assertTrue(ContentDisposition.isInline("INLINE"))
    assertTrue(ContentDisposition.isInline(" inline ;filename=plan.pdf"))
    assertFalse(ContentDisposition.isInline("attachment; filename=\"plan.pdf\""))
    assertFalse(ContentDisposition.isInline("inlined; filename=plan.pdf"))
    assertFalse(ContentDisposition.isInline("form-data; name=file"))
    assertFalse(ContentDisposition.isInline(""))
    assertFalse(ContentDisposition.isInline(null))
  }

  @Test
  fun noNameIsNull() {
    assertNull(ContentDisposition.fileName(null))
    assertNull(ContentDisposition.fileName(""))
    assertNull(ContentDisposition.fileName("attachment"))
    assertNull(ContentDisposition.fileName("attachment; size=12"))
    assertNull(ContentDisposition.fileName("attachment; filename"))
  }
}
