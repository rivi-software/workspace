/**
 * Settings' tabs: which ones a person sees, which one an address opens for them, and what an Account or People form
 * answers. A plain module, so the route renders the tabs from it; what each tab loads and does is its concept's
 * `*.server.ts` module, and `settings.server.ts` names them.
 */
import type { User } from "~/db/schema";

/** Every tab, in the order the header lists them. */
export const SETTINGS_TABS = [
  "account",
  "mail",
  "tasks",
  "groups",
  "people",
  "drive",
  "branding",
  "applications",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tabs only an admin sees, loads and acts in. */
const ADMIN_TABS: ReadonlySet<SettingsTab> = new Set([
  "people",
  "drive",
  "branding",
  "applications",
]);

/** The tabs a person with this role sees, in the header's order. */
export const tabsFor = (role: User["role"]): SettingsTab[] =>
  role === "admin"
    ? [...SETTINGS_TABS]
    : SETTINGS_TABS.filter((tab) => !ADMIN_TABS.has(tab));

/**
 * The tab an address's `tab` opens: the one it names when the person sees it, else Account, for an address without
 * one, a tab that is gone and a member who asks for a tab only an admin sees.
 */
export const openTab = (
  asked: string | undefined,
  role: User["role"]
): SettingsTab => tabsFor(role).find((tab) => tab === asked) ?? "account";

/**
 * What an Account, People or Applications form answers: what went wrong, or what happened and a one-time value to
 * show (a person's one-time password, an application's new secret).
 */
export interface SettingsResult {
  error?: string;
  message?: string;
  password?: string;
}
