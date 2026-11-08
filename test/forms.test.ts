import { describe, expect, it } from "vitest";

import { field, formText } from "~/lib/guards";

/** A form as a browser posts it, with a file where a text field was expected. */
const posted = () => {
  const form = new FormData();
  form.set("name", "Ann");
  form.set("empty", "");
  form.set("upload", new File(["x"], "a.txt", { type: "text/plain" }));

  return form;
};

describe("a posted form's text fields", () => {
  it("reads text as it came, and a missing field or a file as empty, never as [object File]", () => {
    const form = posted();

    expect({
      text: formText(form, "name"),
      empty: formText(form, "empty"),
      missing: formText(form, "absent"),
      file: formText(form, "upload"),
    }).toStrictEqual({ text: "Ann", empty: "", missing: "", file: "" });
  });

  it("answers the fallback for a field that is missing, empty or a file", () => {
    const form = posted();

    expect({
      text: field(form, "name", "fallback"),
      empty: field(form, "empty", "fallback"),
      missing: field(form, "absent", "fallback"),
      file: field(form, "upload", "fallback"),
      noFallback: field(form, "upload"),
    }).toStrictEqual({
      text: "Ann",
      empty: "fallback",
      missing: "fallback",
      file: "fallback",
      noFallback: "",
    });
  });
});
