/**
 * Mail's own addresses in the console, for what links into Mail from outside its routes: the Assistant's answers and
 * steps. A plain module: the client reads it.
 */
import type { Folder } from "./folders";

/** A conversation's page. */
export const threadHref = (threadId: string): string => `/mail/t/${threadId}`;

/** A draft, open in the composer. */
export const draftHref = (draftId: string): string =>
  `/mail/compose?draft=${draftId}`;

/** A view of the list, or a search over it when `q` has words (All mail unless another folder is named). */
export const listHref = (q = "", folder: Folder = "archive"): string =>
  q ? `/mail?folder=${folder}&q=${encodeURIComponent(q)}` : "/mail";
