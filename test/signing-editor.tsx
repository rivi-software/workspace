import { renderToStaticMarkup } from "react-dom/server";

import { EditorLayer } from "~/components/drive/signing-fields";
import type { SigningField } from "~/lib/drive/signing";

/** A control in the markup: its accessible name, and the names of the controls it sits inside. */
export interface Control {
  name: string | null;
  inside: (string | null)[];
}

const TAG = /<(?<closing>\/?)(?<tag>[a-z][a-z0-9]*)(?<rest>[^>]*)>/gu;

const ATTRIBUTE = /(?<key>[a-z-]+)="(?<value>[^"]*)"/gu;

const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
]);

const INTERACTIVE_ROLES = new Set(["button", "checkbox", "link", "switch"]);

const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

const ENTITIES: [RegExp, string][] = [
  [/&quot;/gu, '"'],
  [/&#x27;/gu, "'"],
  [/&lt;/gu, "<"],
  [/&gt;/gu, ">"],
  [/&amp;/gu, "&"],
];

const decode = (text: string): string => {
  let out = text;

  for (const [entity, char] of ENTITIES) {
    out = out.replace(entity, char);
  }

  return out;
};

const isInteractive = (tag: string, attributes: Map<string, string>) => {
  const role = attributes.get("role");
  const tabIndex = attributes.get("tabindex");

  return (
    INTERACTIVE_TAGS.has(tag) ||
    (role !== undefined && INTERACTIVE_ROLES.has(role)) ||
    (tabIndex !== undefined && tabIndex !== "-1")
  );
};

/**
 * The controls of markup React rendered, in document (and so tab) order. React writes every element it opens with its
 * own closing tag, and escapes `>` in attribute values, so the tags alone give the tree.
 */
export const controlsOf = (markup: string): Control[] => {
  // Each open element, with its name when it is a control.
  const open: { control: boolean; name: string | null }[] = [];
  const controls: Control[] = [];

  for (const { groups } of markup.matchAll(TAG)) {
    const { closing, tag = "", rest = "" } = groups ?? {};

    if (closing) {
      open.pop();
      continue;
    }

    const attributes = new Map(
      [...rest.matchAll(ATTRIBUTE)].map((match) => [
        match.groups?.key ?? "",
        decode(match.groups?.value ?? ""),
      ])
    );

    const control = isInteractive(tag, attributes);
    const name = attributes.get("aria-label") ?? null;

    if (control) {
      controls.push({
        name,
        inside: open.flatMap((element) =>
          element.control ? [element.name] : []
        ),
      });
    }

    if (!(VOID_TAGS.has(tag) || rest.endsWith("/"))) {
      open.push({ control, name });
    }
  }

  return controls;
};

const noop = () => {
  // The markup is all a test reads; nothing is pressed.
};

/** The signing editor's layer on the first page with these fields, one of them selected, as its controls. */
export const editorControls = (
  fields: SigningField[],
  selected: string | null
): Control[] =>
  controlsOf(
    renderToStaticMarkup(
      <EditorLayer
        page={0}
        shown={{ width: 595, height: 842, scale: 1 }}
        fields={fields}
        selected={selected}
        tool={null}
        values={{}}
        onChange={noop}
        onSelect={noop}
        onPlaced={noop}
      />
    )
  );
