import { Outlet, createFileRoute } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { z } from "zod";

import { SectionError } from "~/components/section-error";

// The router keeps search values as strings; a search for "2026" would otherwise come back as a number.
const searchSchema = z.object({
  view: z.string().optional(),
  q: z.coerce.string().optional(),
  sort: z.string().optional(),
  dir: z.string().optional(),
});

/** Drive: the root and its views (`/drive?view=`), a folder (`/drive/f/$folderId`) and a file (`/drive/d/$nodeId`). */
export const Route = createFileRoute("/_app/drive")({
  validateSearch: searchSchema,
  component: () => <Outlet />,
});

export const driveTitle = (name: string): string => `${name} · Workspace`;

/** What takes a Drive page's place when it cannot load and there is nothing to keep (#3548): each Drive route's own. */
export const DriveError = ({ error }: ErrorComponentProps) => (
  <SectionError error={error} title="Drive didn't load" />
);
