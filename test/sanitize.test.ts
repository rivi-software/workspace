import { describe, expect, it } from "vitest";

import {
  contrast,
  DARK_SURFACE,
  darkBackground,
  darkText,
  formatColor,
  lightness,
  parseColor,
} from "~/lib/mail/colors";
import {
  MAX_HTML,
  mailDocument,
  mailReading,
  sanitizeHtml,
  withoutStyles,
} from "~/lib/mail/sanitize";
import { textToHtml, withSignature } from "~/lib/text";

import { defined, sorted } from "./fixtures";

const cidUrl = (cid: string) =>
  cid === "logo" ? "/api/files/att_1?exp=1&sig=x" : null;

const origin = "https://workspace.rivi.software";

const read = (html: string) =>
  sanitizeHtml(html, { cidUrl, forward: true }).html;

const folded = (html: string, forward = false) =>
  sanitizeHtml(html, { cidUrl, forward }).html.includes(
    '<details class="rivi-quote">'
  );

// Markup whose close never comes: the expressions that read it searched again from every opening for a `-->`, `]]>`,
// `>` or end tag that was not there, so 40 KB took up to 2.6 s (#3591). At 200,000 characters each of these took the
// old sanitiser more than a second and takes this one a few milliseconds: the budget sits between, wide of both, and
// small enough that the tests running beside these keep their CPU.
const CRAFTED_SIZE = 200_000;
const CRAFTED_BUDGET_MS = 500;

/** The units that, repeated to `CRAFTED_SIZE` (or once, when longer), take `reader` (the sanitiser) the budget or more. */
const slowToRead = (
  units: string[],
  reader: (html: string) => void = (html) => {
    sanitizeHtml(html, { cidUrl });
  }
) =>
  units.filter((unit) => {
    const html = unit.repeat(Math.ceil(CRAFTED_SIZE / unit.length));
    const started = performance.now();
    reader(html);

    return performance.now() - started >= CRAFTED_BUDGET_MS;
  });

const light = { dark: false, sheet: false };
const dark = { dark: true, sheet: false };

/** The body of the document a message gets in the dark theme, and the reading it got. */
const inDark = (html: string, swapped = false) => {
  const safe = sanitizeHtml(html, { cidUrl }).html;
  const reading = mailReading(safe, { dark: true, swapped });
  const doc = mailDocument(safe, { origin, loadRemoteImages: false, reading });

  return { reading, doc, body: doc.slice(doc.indexOf("<body>")) };
};

describe(sanitizeHtml, () => {
  it("drops scripts, frames, forms and event handlers, and keeps the text", () => {
    const { html } = sanitizeHtml(
      `<html><head><title>x</title><meta http-equiv="refresh" content="0;url=https://evil"><style>p{color:red}</style></head>
       <body onload="alert(1)"><p onclick="alert(1)" style="color:blue">Hello <b>world</b></p>
       <script>alert(1)</script><iframe src="https://evil"></iframe><form action="/x"><input name="a"><button>Go</button></form>
       <a href="javascript:alert(1)">bad</a> <a href="https://rivi.software">good</a></body></html>`,
      { cidUrl }
    );

    expect(html).not.toMatch(
      /<script|<iframe|<form|<input|<button|<meta|<title|onload|onclick|javascript:/iu
    );
    expect(html).toContain("<style>p{color:red}</style>");
    expect(html).toContain('<p style="color:blue">Hello <b>world</b></p>');
    expect(html).toContain(
      '<a target="_blank" rel="noopener noreferrer">bad</a>'
    );
    expect(html).toContain(
      '<a href="https://rivi.software" target="_blank" rel="noopener noreferrer">good</a>'
    );
  });

  it("reads a URL's scheme as the browser does, references decoded and tabs removed", () => {
    for (const href of [
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:alert(1)",
      "&#106avascript:alert(1)",
      "java\tscript:alert(1)",
      "java&#10;script:alert(1)",
      "java&Tab;script:alert(1)",
      "javascript&colon;alert(1)",
      " \u0001javascript:alert(1)",
    ]) {
      const { html } = sanitizeHtml(`<a href="${href}">x</a>`, { cidUrl });
      expect({ href, html }).toStrictEqual({
        href,
        html: '<a target="_blank" rel="noopener noreferrer">x</a>',
      });
    }

    // A link that only looks like a reference stays the link it was.
    const { html } = sanitizeHtml(
      '<a href="https://x.test/?a=1&amp;b=2&gt=3">x</a>',
      { cidUrl }
    );

    expect(html).toContain('href="https://x.test/?a=1&amp;b=2&amp;gt=3"');
  });

  it("opens every link in a new tab, whatever target the sender gave", () => {
    const { html } = sanitizeHtml(
      '<a href="https://x.test" target="_self" rel="opener">a</a><map><area href="https://y.test" target="_top"></map>',
      { cidUrl }
    );

    expect(html).toBe(
      '<a href="https://x.test" target="_blank" rel="noopener noreferrer">a</a><map><area href="https://y.test" target="_blank" rel="noopener noreferrer"></map>'
    );
  });

  it("rewrites cid images to the attachment links and reports remote images", () => {
    const inline = sanitizeHtml(
      '<img src="cid:logo" width="10"><img src="cid:missing">',
      {
        cidUrl,
      }
    );

    expect(inline.html).toBe(
      '<img src="/api/files/att_1?exp=1&amp;sig=x" width="10" alt=""><img alt="">'
    );
    expect(inline.remoteImages).toBeFalsy();

    const remote = sanitizeHtml(
      '<img src="https://tracker.example/p.gif" alt="">',
      { cidUrl }
    );

    expect(remote.remoteImages).toBeTruthy();
    expect(remote.html).toContain('src="https://tracker.example/p.gif"');
    const relative = sanitizeHtml('<img src="/local.png">', { cidUrl });
    expect(relative.html).toBe('<img alt="">');
  });

  it("neutralises CSS that runs code or loads, also behind character references", () => {
    const { html } = sanitizeHtml(
      '<style>@import url(https://evil/x.css); a{behavior:url(x.htc)}</style><p style="width:expression(alert(1));background:url(javascript:alert(1))">x</p><p style="background:url(&#106;avascript:alert(1))">y</p>',
      { cidUrl }
    );

    expect(html).not.toMatch(
      /@import|behavior|expression\(|javascript:|&#106;/iu
    );
  });

  it("lets markup it could not read as a tag through as text, never as a tag the markup around it completes", () => {
    // Cut off at the end (a reply's quote closes it), and with quotes that do not pair up (CORE-1302).
    expect({
      "<p>Hi</p><img src=x onerror=alert(1)//": read(
        "<p>Hi</p><img src=x onerror=alert(1)//"
      ),
      '<img src=x onerror=alert(1) title=a"b>': read(
        '<img src=x onerror=alert(1) title=a"b>'
      ),
    }).toStrictEqual({
      "<p>Hi</p><img src=x onerror=alert(1)//":
        "<p>Hi</p>&lt;img src=x onerror=alert(1)//",
      '<img src=x onerror=alert(1) title=a"b>':
        '&lt;img src=x onerror=alert(1) title=a"b>',
    });
    // The browser reads an xmp's or noembed's content as text: an attribute here would close it.
    expect({
      '<xmp><img title="</xmp><img src=x onerror=alert(1)>"></xmp>': read(
        '<xmp><img title="</xmp><img src=x onerror=alert(1)>"></xmp>'
      ),
      read: read(
        '<noembed><b title="</noembed><img src=x onerror=alert(1)>">x</b></noembed>'
      ),
    }).toStrictEqual({
      '<xmp><img title="</xmp><img src=x onerror=alert(1)>"></xmp>':
        '<img title="&lt;/xmp&gt;&lt;img src=x onerror=alert(1)&gt;" alt="">',
      read: '<b title="&lt;/noembed&gt;&lt;img src=x onerror=alert(1)&gt;">x</b>',
    });
    // `</style >` ends a style element in the browser, not in the regular expression that lifted it.
    expect(
      read("<style>a{}</style ><img src=x onerror=alert(1)></style><p>x</p>")
    ).toBe(
      "<style>a{}\\3c /style >\\3c img src=x onerror=alert(1)></style><p>x</p>"
    );
    // An SVG animation would set the link's href after it was checked.
    expect(
      read(
        '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>'
      )
    ).toBe(
      '<svg><a target="_blank" rel="noopener noreferrer"><text>x</text></a></svg>'
    );
  });

  it("drops what the browser drops as a bogus comment, Outlook's conditional ones included", () => {
    const { html } = sanitizeHtml(
      '<!doctype html><?xml version="1.0"?><![if !supportLists]><span>1.</span><![endif]><p>a &lt; b <3</p>',
      { cidUrl }
    );

    expect(html).toBe("<span>1.</span><p>a &lt; b &lt;3</p>");
  });

  it("drops an unclosed style element with everything after it", () => {
    const { html } = sanitizeHtml("<p>Hi</p><style>p{color:red}<p>gone", {
      cidUrl,
    });

    expect(html).toBe("<p>Hi</p>");
  });

  it("reads a comment, CDATA or a tag left open as it read them before (#3591)", () => {
    expect({
      // Without its `-->` or `]]>`, a comment or CDATA is a bogus comment to the first `>`.
      comment: read("<p>a</p><!-- open <b>x</b>"),
      cdata: read("<![CDATA[x]]><p>y</p>"),
      openCdata: read("<![CDATA[ x <p>y</p>"),
      // A `<` that starts no tag, or that no `>` ends, is text; a `>` in a quoted value is the value's.
      text: read("<p>1 < 2</p>and <b this"),
      quoted: read(`<p title="a>b" lang='c"d'>x</p>`),
      selfClosing: read('<br/><p title="x/">y</p><script/>z'),
      // A closed style is lifted, one left open goes with everything after it.
      styles: read("<style>a{}</style><p>x</p><style>b{}<p>gone"),
      // What the browser reads as text is read as markup, its own tags gone.
      textElements: read("<noframes><b>x</b></noframes><plaintext>y"),
    }).toStrictEqual({
      comment: "<p>a</p>x</b>",
      cdata: "<p>y</p>",
      openCdata: "y</p>",
      text: "<p>1 &lt; 2</p>and &lt;b this",
      quoted: '<p title="a&gt;b" lang="c&quot;d">x</p>',
      selfClosing: '<br /><p title="x/">y</p>z',
      styles: "<style>a{}</style><p>x</p>",
      textElements: "<b>x</b>y",
    });
  });

  it("neutralises a URL in CSS behind spaces and a quote", () => {
    expect(
      read(
        `<p style="background:url(  ' javascript:x')">x</p><style>a{background:url( "data:text/html,x" )}</style>`
      )
    ).toBe('<style>a{background:none}</style><p style="background:none">x</p>');
  });

  it("reads only the first MAX_HTML characters of a longer part, and says so", () => {
    const within = "<p>within</p>";
    const pad = " ".repeat(MAX_HTML - within.length);

    expect({
      longer: read(`${pad}${within}<p>beyond</p>`).trim(),
      exactly: read(`${pad}${within}`).trim(),
    }).toStrictEqual({
      longer: `${within}<p>[Message clipped: it is longer than Workspace shows, and only its start is here.]</p>`,
      exactly: within,
    });
  });

  it("reads 80,000 unclosed comments, doctypes, CDATA sections or tags in linear time, all as text (#3591)", () => {
    const units = ["<!--", "<!", "<![CDATA[", "<a <"];

    expect(
      units.filter((unit) => {
        const html = unit.repeat(80_000);
        const started = performance.now();
        const out = read(html);

        return (
          performance.now() - started >= 100 ||
          out !== html.replaceAll("<", "&lt;")
        );
      })
    ).toStrictEqual([]);
  });

  it("reads comments, doctypes, CDATA and dropped elements that never close in linear time (#3591)", () => {
    expect(
      slowToRead([
        "<!--",
        "<!",
        "<?",
        "<![CDATA[",
        "<!--x--><!--",
        "<style>",
        "<style",
        "<STYLE>",
        "<script>",
        "<script><a <",
      ])
    ).toStrictEqual([]);
  });

  it("reads tags that never end in linear time (#3591)", () => {
    expect(
      slowToRead([
        "<",
        "<a",
        "<a <",
        '<a "',
        '<a "<b "',
        "<a \"'<b ",
        "<p title='",
      ])
    ).toStrictEqual([]);
    // One unit each, under the bound so that its close is read: one tag name, CSS whose expressions read on from one
    // opening to the end, and kept `<style-x>` tags, from each of which the quote's fold searched for a `</style>`.
    const room = CRAFTED_SIZE - 100;

    expect(
      slowToRead([
        `<${"a".repeat(room)}`,
        `<style>url(${" ".repeat(room)}</style>`,
        `<style>${"expression(".repeat(Math.floor(room / 11))}</style>`,
        `<p style="${"url(javascript:".repeat(Math.floor(room / 15))}">`,
        `x<div class="gmail_quote">y</div>${"<style-x>".repeat(Math.floor(room / 9))}`,
      ])
    ).toStrictEqual([]);
  });

  it("takes the style element out of a quote, a signature or what is sent, in linear time, and keeps `style-` tags (#3591)", () => {
    const { html } = sanitizeHtml(
      "<style>p{}</style><style-x>a</style-x><p>b</p>",
      { cidUrl }
    );

    expect({
      html,
      without: withoutStyles(html),
      slow: slowToRead(["<style-x>", "<style "], withoutStyles),
    }).toStrictEqual({
      html: "<style>p{}</style><style-x>a</style-x><p>b</p>",
      without: "<style-x>a</style-x><p>b</p>",
      slow: [],
    });
  });

  it("keeps the body's colours on a div in its place", () => {
    const { html } = sanitizeHtml(
      '<body bgcolor="#f4f4f4" text="#333333" link="#00f" leftmargin="0" style="margin:0" dir="ltr"><p>x</p></body>',
      { cidUrl }
    );

    expect(html).toBe(
      '<div style="background-color:#f4f4f4;color:#333333;margin:0" dir="ltr"><p>x</p></div>'
    );
  });

  it("carries a color-scheme meta over as CSS", () => {
    const { html } = sanitizeHtml(
      '<head><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light; x{}"></head><p>x</p>',
      { cidUrl }
    );

    expect(html).toBe("<style>:root{color-scheme:light dark}</style><p>x</p>");
  });
});

describe("quoted text", () => {
  it("folds the quote under a Gmail, Apple Mail and Outlook reply", () => {
    const gmail = sanitizeHtml(
      '<div dir="ltr">Sounds good</div><br><div class="gmail_quote"><div class="gmail_attr">On Fri, Jane wrote:</div><blockquote class="gmail_quote"><div>Monday?</div></blockquote></div>',
      { cidUrl }
    ).html;

    expect(gmail).toBe(
      '<div dir="ltr">Sounds good</div><details class="rivi-quote"><summary><span class="rivi-show">Show quoted text</span><span class="rivi-hide">Hide quoted text</span></summary><div class="gmail_quote"><div class="gmail_attr">On Fri, Jane wrote:</div><blockquote class="gmail_quote"><div>Monday?</div></blockquote></div></details>'
    );
    // Apple Mail's blank lines around the quote go with the fold; a line break inside the reply stays.
    expect(
      sanitizeHtml(
        '<body>Yes,<br>see you.<br id="x"><div><br><blockquote type="cite"><div>On 24 Oct, Admin wrote:</div><div>Tuesday?<br>Or Wednesday?</div></blockquote></div><br></body>',
        { cidUrl }
      ).html
    ).toMatch(
      /^<div>Yes,<br>see you\.<div><details class="rivi-quote">.*Tuesday\?<br>Or Wednesday\?<\/div><\/blockquote><\/details><\/div><\/div>$/u
    );

    const outlook = sanitizeHtml(
      '<body><div>Hi, see attached.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Admin</div><div>Could you send it?</div></body>',
      { cidUrl }
    ).html;

    expect(outlook).toMatch(
      /^<div><div>Hi, see attached\.<\/div><details class="rivi-quote">.*<div id="appendonsend"><\/div><hr>.*Could you send it\?<\/div><\/div><\/details>$/u
    );
  });

  it("folds a quote with a signature under it, and the signature keeps its lines", () => {
    const { html } = sanitizeHtml(
      '<p>Monday it is.</p><div class="gmail_quote"><p>On Fri, Jane wrote:</p><blockquote type="cite">Monday?</blockquote></div><br><p>-- <br>Alex Admin<br>RIVI Software</p>',
      { cidUrl }
    );

    expect(html).toMatch(
      /<\/details><p>-- <br>Alex Admin<br>RIVI Software<\/p>$/u
    );
  });

  it("keeps quotes in view between inline answers, alone, and in a forward", () => {
    expect(
      folded(
        '<blockquote type="cite">Monday?</blockquote><p>Yes.</p><blockquote type="cite">Where?</blockquote><p>Here.</p>'
      )
    ).toBeFalsy();
    expect(folded('<div class="gmail_quote">Only a quote</div>')).toBeFalsy();
    expect(
      folded(
        'FYI<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Jane</div>Plan</div>'
      )
    ).toBeFalsy();
    expect(
      folded('FYI<div id="divRplyFwdMsg">From: Jane</div><div>Plan</div>', true)
    ).toBeFalsy();
  });
});

describe(mailDocument, () => {
  it("wraps the markup in a document whose CSP blocks the web until images are allowed", () => {
    const locked = mailDocument("<p>x</p>", {
      origin,
      loadRemoteImages: false,
      reading: light,
    });

    expect(locked).toContain(
      "default-src 'none'; img-src https://workspace.rivi.software data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"
    );

    const open = mailDocument("<p>x</p>", {
      origin,
      loadRemoteImages: true,
      reading: { dark: true, sheet: false },
    });

    expect(open).toContain(
      "img-src https://workspace.rivi.software https: http: data:"
    );
    expect(open).toContain("color-scheme:dark");
  });

  it("adapts a plain message to the dark theme: dark text light, white backgrounds gone", () => {
    const { reading, body } = inDark(
      '<div style="font-family: Aptos; color: rgb(0, 0, 0);">Hi <span style="color:#c45911">there</span></div><font color="#000000">From</font><div style="background-color:#ffffff;border-top:1px solid #e1e1e1">x</div>'
    );

    expect(reading).toStrictEqual(dark);
    expect(body).not.toMatch(/rgb\(0, 0, 0\)|#000000|#c45911|#ffffff|#e1e1e1/u);
    expect({
      body: body.includes("font-family: Aptos;"),
      body2: body.includes("background-color:transparent"),
    }).toStrictEqual({ body: true, body2: true });

    const colors = [
      ...body.matchAll(/color(?:="|: ?)(?<color>#[0-9a-f]{6})/gu),
    ].map((m) => defined(parseColor(m[1])));

    expect(colors).toHaveLength(3);

    for (const c of colors) {
      expect(contrast(c, DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps a designed message as sent, on a light sheet, until the reader switches", () => {
    const receipt =
      '<table bgcolor="#f6f9fc"><tr><td style="background-color:#635bff;color:#ffffff">Acme</td></tr><tr><td style="color:#32325d">Receipt</td></tr></table>';

    const auto = inDark(receipt);
    expect({
      reading: auto.reading,
      body: auto.body.includes("color:#32325d"),
    }).toStrictEqual({ reading: light, body: true });
    const swapped = inDark(receipt, true);

    const imaged = inDark(
      '<div style="background:url(https://x.test/bg.png)">x</div>'
    );

    expect({
      swappedReading: swapped.reading,
      swappedKeepsColor: swapped.body.includes("color:#32325d"),
      body: swapped.body.includes('bgcolor="transparent"'),
      reading: imaged.reading,
    }).toStrictEqual({
      swappedReading: dark,
      swappedKeepsColor: false,
      body: true,
      reading: light,
    });

    // A highlight is not a design: it turns into a dark highlight.
    const highlight = inDark(
      '<p>a <span style="background-color:yellow">b</span></p>'
    );

    // Nor is a pale tint on a block: Outlook's shaded table header, a grey card.
    const table = inDark(
      '<table><tr style="background:#eeeeee"><th>Day</th></tr><tr><td style="background:#D9E2F3;color:black">Mon</td></tr></table><style>.card{background:#f3f4f6}</style>'
    );

    expect({
      highlightReading: highlight.reading,
      highlightKeepsYellow: highlight.body.includes("yellow"),
      tableReading: table.reading,
      tableKeepsTint: /#eeeeee|#D9E2F3|#f3f4f6|black/iu.test(table.doc),
    }).toStrictEqual({
      highlightReading: dark,
      highlightKeepsYellow: false,
      tableReading: dark,
      tableKeepsTint: false,
    });
  });

  it("gives a plain message read light in the dark theme a margin on its sheet", () => {
    const plain = inDark('<p style="color:#000">Hi</p>', true);
    expect(plain.reading).toStrictEqual({ dark: false, sheet: true });
    expect(plain.doc).toContain("background:#ffffff;padding:12px 16px}");

    // A designed message brings its own margins, often a background to the edge.
    const designed = inDark(
      '<div style="background:#000;color:#fff">Deployed</div>'
    );

    expect(designed.reading).toStrictEqual(light);
    expect(designed.doc).not.toContain("padding:12px 16px");
  });

  it("follows the reading, not the system, for a message with its own dark mode", () => {
    const { html } = sanitizeHtml(
      '<meta name="color-scheme" content="light dark"><style>.w{background:#fff} @media (prefers-color-scheme: dark){.w{background:#101113 !important}} @media (prefers-color-scheme: light){.l{display:block}}</style><div class="w" style="color:#222326">x</div>',
      { cidUrl }
    );

    const reading = mailReading(html, { dark: true });

    const doc = mailDocument(html, {
      origin,
      loadRemoteImages: false,
      reading,
    });

    expect({
      reading,
      doc: doc.includes(
        "@media (min-width:0){.w{background:#101113 !important}}"
      ),
      doc2: doc.includes("@media (max-width:0){.l{display:block}}"),
      keepsRootScheme: /:root\{color-scheme/u.test(doc),
      // What its dark mode forgot is adapted: the text it left dark on its own dark background reads.
      adaptsForgotten: doc.includes(".w{background:transparent}"),
    }).toStrictEqual({
      reading: dark,
      doc: true,
      doc2: true,
      keepsRootScheme: false,
      adaptsForgotten: true,
    });

    const [, text] = defined(
      doc.match(/style="color:(?<color>#[0-9a-f]{6})"/u)
    );

    expect(
      contrast(defined(parseColor(text)), defined(parseColor("#101113")))
    ).toBeGreaterThanOrEqual(4.5);

    const lit = mailDocument(html, {
      origin,
      loadRemoteImages: false,
      reading: light,
    });

    expect({
      lit: lit.includes(
        "@media (max-width:0){.w{background:#101113 !important}}"
      ),
      lit2: lit.includes("@media (min-width:0){.l{display:block}}"),
      lit3: lit.includes('style="color:#222326"'),
      mailReading: mailReading(html, { dark: true, swapped: true }),
      mailReading2: mailReading(html, { dark: false, swapped: true }),
    }).toStrictEqual({
      lit: true,
      lit2: true,
      lit3: true,
      mailReading: {
        dark: false,
        sheet: true,
      },
      mailReading2: light,
    });
  });

  it("takes a color-scheme declaration without dark-mode CSS for no dark mode", () => {
    const { reading, body } = inDark(
      '<meta name="color-scheme" content="light dark"><h2 style="color:#111111">Invoice</h2><p style="color:#333333">Attached.</p>'
    );

    expect(reading).toStrictEqual(dark);
    expect(body).not.toMatch(/#111111|#333333/u);
  });

  it("drops heights in viewport units, which would grow the frame without end", () => {
    const { doc } = inDark(
      '<style>.w{height:calc(100vh - 20px);width:50vw}</style><div class="w" style="min-height:100vh;padding:20px;max-height:80dvh;background:url(https://x.test/1vh.png)">x</div>'
    );

    expect(doc).not.toMatch(/100vh|80dvh/u);
    expect(doc).toContain("width:50vw");
    expect(doc).toContain("padding:20px");
    expect(doc).toContain("url(https://x.test/1vh.png)");
  });

  it("leaves selectors, URLs and variables alone while it rewrites colours", () => {
    const { doc, body } = inDark(
      '<style>a.red:hover{color:black} .x{border:1px solid var(--red)}</style><p style="color:black;background:transparent url(https://x.test/red.png)">x</p>',
      true
    );

    expect(doc).toMatch(
      /a\.red:hover\{color:#[0-9a-f]{6}\} \.x\{border:1px solid var\(--red\)\}/u
    );
    expect(body).toMatch(
      /<p style="color:#[0-9a-f]{6};background:transparent url\(https:\/\/x\.test\/red\.png\)">x<\/p>/u
    );
    expect(doc).not.toContain("black");
  });
});

describe("colours", () => {
  it("parses the forms mail uses and writes them back", () => {
    expect({
      formatColor: formatColor(defined(parseColor("#FFF"))),
      formatColor2: formatColor(defined(parseColor("rgb(196, 89, 17)"))),
      formatColor3: formatColor(defined(parseColor("rgb(196 89 17 / 50%)"))),
      formatColor4: formatColor(defined(parseColor("hsl(120, 100%, 25%)"))),
      formatColor5: formatColor(defined(parseColor("WindowText"))),
      formatColor6: formatColor(defined(parseColor("rebeccapurple"))),
      a: defined(parseColor("transparent")).a,
    }).toStrictEqual({
      formatColor: "#ffffff",
      formatColor2: "#c45911",
      formatColor3: "rgba(196, 89, 17, 0.5)",
      formatColor4: "#008000",
      formatColor5: "#000000",
      formatColor6: "#663399",
      a: 0,
    });

    for (const v of [
      "inherit",
      "currentColor",
      "#12",
      "var(--x)",
      "constructor",
      "rgb(1,2)",
    ]) {
      expect({ v, color: parseColor(v) }).toStrictEqual({ v, color: null });
    }
  });

  it("lightens dark text in reverse order, and every result reads on the dark card", () => {
    const greys = ["#000000", "#1f2023", "#333333", "#666666"].map((h) =>
      lightness(darkText(defined(parseColor(h))))
    );

    expect(greys).toStrictEqual(sorted(greys, (a, b) => b - a));

    for (let i = 0; i < 400; i += 1) {
      const c = {
        r: ((i * 37) % 256) / 255,
        g: ((i * 91) % 256) / 255,
        b: ((i * 53) % 256) / 255,
        a: 1,
      };

      expect(contrast(darkText(c), DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
    }

    // Light enough already: untouched.
    expect(formatColor(darkText(defined(parseColor("#9a9ea7"))))).toBe(
      "#9a9ea7"
    );
  });

  it("removes white backgrounds and turns light ones dark, keeping their hue", () => {
    expect(darkBackground(defined(parseColor("#f6f9fc"))).a).toBe(0);
    const yellow = darkBackground(defined(parseColor("#ffff00")));
    expect(lightness(yellow)).toBeLessThan(0.45);
    expect(yellow.r).toBeGreaterThan(yellow.b);
    expect(formatColor(darkBackground(defined(parseColor("#101113"))))).toBe(
      "#101113"
    );
  });
});

describe(textToHtml, () => {
  it("writes no text colour, and the quote under a reply as Gmail does", () => {
    const html = textToHtml(
      "Sounds good.\n\nOn 24 Oct 2026, Jane <jane@acme.com> wrote:\n> Monday?\n>\n>> Earlier\n\nP.S. bring the agenda"
    );

    expect(html).not.toMatch(/[^-]color:/u);
    expect({
      html: html.includes(
        '<p style="margin:0 0 16px">Sounds good.</p><div class="gmail_quote"><p style="margin:0 0 16px">On 24 Oct 2026, Jane &lt;<a href="mailto:jane@acme.com" target="_blank" rel="noopener noreferrer">jane@acme.com</a>&gt; wrote:</p><blockquote type="cite"'
      ),
      html2:
        /Monday\?<\/p><blockquote type="cite"[^>]*><p[^>]*>Earlier<\/p><\/blockquote><\/blockquote><\/div><p[^>]*>P\.S\. bring the agenda<\/p>/u.test(
          html
        ),
    }).toStrictEqual({ html: true, html2: true });
    // The P.S. after the quote keeps it in view here; a quote at the end folds.
    expect(sanitizeHtml(html, { cidUrl }).html).not.toContain("rivi-quote");
    expect(
      sanitizeHtml(textToHtml("Yes.\n\nOn Fri, Jane wrote:\n> Monday?"), {
        cidUrl,
      }).html
    ).toContain('<details class="rivi-quote">');
    expect(
      textToHtml("FYI\n\n---------- Forwarded message ---------\nFrom: Jane")
    ).not.toContain("gmail_quote");
  });

  it("signs above the quoted original, and at the end of a new message", () => {
    expect(withSignature("Here is the plan.\n", "Sam\nRIVI")).toBe(
      "Here is the plan.\n\n-- \nSam\nRIVI"
    );
    expect(
      withSignature("Monday it is.\n\nOn Fri, Jane wrote:\n> Monday?", "Sam")
    ).toBe("Monday it is.\n\n-- \nSam\n\nOn Fri, Jane wrote:\n> Monday?");
    expect(
      withSignature(
        "FYI\n\n---------- Forwarded message ---------\nFrom: Jane",
        "Sam"
      )
    ).toBe(
      "FYI\n\n-- \nSam\n\n---------- Forwarded message ---------\nFrom: Jane"
    );

    // The signed reply, as this app shows it: the signature in view, the quote folded under it.
    const { html } = sanitizeHtml(
      textToHtml(
        withSignature("Monday it is.\n\nOn Fri, Jane wrote:\n> Monday?", "Sam")
      ),
      { cidUrl }
    );

    expect(html).toMatch(
      /Monday it is\.<\/p><p[^>]*>-- <br>Sam<\/p><details class="rivi-quote">/u
    );
  });
});
