import { useEffect, useId, useState } from "react";

import { useAction } from "~/lib/action";
import { brandingAction } from "~/lib/branding-actions";

import { BrandMark } from "./brand";
import { Button, Notice, Section, Timestamp, inputClass } from "./ui";

/** What the icon may be (`ICON_TYPES` in branding.server.ts), for the file picker. */
const ICON_ACCEPT = "image/png,image/svg+xml,image/webp,image/jpeg";

/** app.css's own accent, which the colour picker starts from when none is set. */
const DEFAULT_ACCENT = "#0a7f43";

/**
 * After a change, this page's brand links point at addresses it has not loaded yet, so the browser fetches the new
 * stylesheet and icon at once instead of keeping the ones it holds; every other page asks again when it loads
 * (`no-cache` in branding.server.ts).
 */
const refreshBrandLinks = () => {
  const stamp = String(Date.now());

  for (const link of document.querySelectorAll<HTMLLinkElement>(
    'link[rel="stylesheet"], link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]'
  )) {
    const url = new URL(link.href);

    if (url.pathname.startsWith("/brand/")) {
      url.searchParams.set("v", stamp);
      link.href = url.pathname + url.search;
    }
  }
};

const Feedback = ({
  data,
  error,
}: {
  data: { error?: string; message?: string } | undefined;
  error: string | null;
}) => (
  <>
    {(data?.error ?? error) && (
      <Notice tone="error">{data?.error ?? error}</Notice>
    )}
    {data?.message && <Notice tone="success">{data.message}</Notice>}
  </>
);

/** The accent form: a picker and the same colour as text, which takes any CSS colour. */
const AccentForm = ({
  color,
  updatedBy,
  updatedAt,
}: {
  color: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}) => {
  const act = useAction(brandingAction);
  const [picked, setPicked] = useState(color ?? DEFAULT_ACCENT);
  const hint = useId();

  useEffect(() => {
    if (act.data?.message) {
      refreshBrandLinks();
    }
  }, [act.data]);

  return (
    <act.Form className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label="Pick the accent colour"
          value={picked}
          onChange={(e) => setPicked(e.currentTarget.value)}
          className="border-line h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent p-0.5"
        />
        <input
          name="color"
          value={picked}
          onChange={(e) => setPicked(e.currentTarget.value)}
          aria-label="Accent colour"
          aria-describedby={hint}
          spellCheck={false}
          className={`${inputClass} max-w-40 font-mono`}
        />
      </div>
      <p id={hint} className="text-muted text-sm">
        Buttons, links, the selection and the focus ring, in the light and the
        dark theme. Any CSS colour; it is darkened or lightened only as far as
        text needs to read on it.
        {updatedAt && (
          <>
            {" "}
            Branding last changed by {updatedBy ?? "an admin"},{" "}
            <Timestamp iso={updatedAt} relative={false} />.
          </>
        )}
      </p>
      <Feedback data={act.data} error={act.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          name="intent"
          value="color"
          variant="primary"
          loading={act.state === "submitting"}
        >
          Save
        </Button>
        {color && (
          <Button
            type="submit"
            name="intent"
            value="color-reset"
            onClick={() => setPicked(DEFAULT_ACCENT)}
          >
            Use the default green
          </Button>
        )}
      </div>
    </act.Form>
  );
};

/** The icon form: upload a new one, or go back to the default mark. */
const IconForm = ({ icon }: { icon: { type: string } | null }) => {
  const act = useAction(brandingAction);
  const hint = useId();

  useEffect(() => {
    if (act.data?.message) {
      refreshBrandLinks();
    }
  }, [act.data]);

  return (
    <act.Form className="space-y-3 p-4">
      <div className="flex items-center gap-3">
        <BrandMark className="text-[40px]" />
        <input
          type="file"
          name="icon"
          accept={ICON_ACCEPT}
          aria-label="Icon image"
          aria-describedby={hint}
          className="text-muted min-w-0 text-sm"
        />
      </div>
      <p id={hint} className="text-muted text-sm">
        A square image of at most 1 MB for the browser tab, the Home Screen,
        notifications and the sidebar: a PNG of at least 512 × 512, or an SVG.
        The Home Screen on iPhone and iPad shows a PNG only.
      </p>
      <Feedback data={act.data} error={act.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          name="intent"
          value="icon"
          variant="primary"
          loading={act.state === "submitting"}
        >
          Upload
        </Button>
        {icon && (
          <Button type="submit" name="intent" value="icon-remove">
            Use the default mark
          </Button>
        )}
      </div>
    </act.Form>
  );
};

/**
 * Settings → Branding, for an admin: the accent of buttons, links and the selection in both themes, and the icon of
 * the tab, the Home Screen, notifications and the sidebar. The Worker serves both under `/brand/`.
 */
export const BrandingSettings = ({
  color,
  icon,
  updatedBy,
  updatedAt,
}: {
  color: string | null;
  icon: { type: string; version: string } | null;
  updatedBy: string | null;
  updatedAt: string | null;
}) => (
  <>
    <Section title="Accent colour">
      <AccentForm color={color} updatedBy={updatedBy} updatedAt={updatedAt} />
    </Section>
    <Section title="Icon">
      <IconForm icon={icon} />
    </Section>
  </>
);
