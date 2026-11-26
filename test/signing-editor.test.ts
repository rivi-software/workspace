import { describe, expect, it } from "vitest";

import type { SigningField } from "~/lib/drive/signing";

import { controlsOf, editorControls } from "./signing-editor";

const field = (id: string, change: Partial<SigningField>): SigningField => ({
  id,
  kind: "signature",
  party: "customer",
  page: 0,
  x: 0.1,
  y: 0.1,
  w: 0.3,
  h: 0.06,
  label: "Signature",
  required: true,
  ...change,
});

const FIELDS = [
  field("f1", {}),
  field("f2", { kind: "text", party: "rivi", label: "Full name", y: 0.5 }),
];

describe("the signing editor's fields", () => {
  it("reads the controls of markup and what they sit inside", () => {
    expect(
      controlsOf(
        '<div role="button" tabindex="0" aria-label="Outer &amp; co"><span><button type="button" aria-label="Inner"></button></span></div><input aria-label="Last"/>'
      )
    ).toStrictEqual([
      { name: "Outer & co", inside: [] },
      { name: "Inner", inside: ["Outer & co"] },
      { name: "Last", inside: [] },
    ]);
  });

  // A screen reader takes a button's contents for its label, so a remove button inside the field was never reached
  // (#3794): it follows the field in the tab order instead, a control of its own.
  it("puts the selected field's remove button beside the field, not inside it", () => {
    expect(editorControls(FIELDS, "f1")).toStrictEqual([
      { name: "Customer: Signature", inside: [] },
      { name: "Remove Signature for Customer", inside: [] },
      { name: "Workspace: Full name", inside: [] },
    ]);
  });

  it("shows a remove button only for the selected field", () => {
    expect([
      editorControls(FIELDS, null),
      editorControls(FIELDS, "f2"),
    ]).toStrictEqual([
      [
        { name: "Customer: Signature", inside: [] },
        { name: "Workspace: Full name", inside: [] },
      ],
      [
        { name: "Customer: Signature", inside: [] },
        { name: "Workspace: Full name", inside: [] },
        { name: "Remove Full name for Workspace", inside: [] },
      ],
    ]);
  });
});
