// What Settings loads (`app/lib/settings.server.ts`): the open tab's slice alone, for whom, and the forms of the tabs
// that have no test file of their own here (Mail, OpenPGP, Tasks, Drive) through their intent handlers.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import {
  driveSettings,
  driveSettingsIntent,
} from "~/lib/drive/settings.server";
import { pgpIntent } from "~/lib/mail/pgp/settings.server";
import { mailSettingsIntent } from "~/lib/mail/settings.server";
import { peopleSettings } from "~/lib/people.server";
import { SETTINGS_TABS, openTab, tabsFor } from "~/lib/settings";
import { loadSettings } from "~/lib/settings.server";
import type { Settings } from "~/lib/settings.server";
import {
  applicationsIntent,
  applicationsSettings,
} from "~/lib/sso/settings.server";
import { githubIntent, tasksSettings } from "~/lib/tasks/settings.server";

import {
  adminMailbox,
  db,
  formOf,
  mailbox,
  rejection,
  requestAs,
} from "./fixtures";

/** Which keys a loaded Settings carries: the open tab's slice and who is looking, nothing else. */
const keysOf = (loaded: Settings) => Object.keys(loaded).toSorted();

describe("Settings' tabs", () => {
  it("shows a member Account, Mail and Tasks, and an admin every tab", () => {
    expect({
      member: tabsFor("member"),
      admin: tabsFor("admin"),
    }).toStrictEqual({
      member: ["account", "mail", "tasks"],
      admin: [
        "account",
        "mail",
        "tasks",
        "people",
        "drive",
        "branding",
        "applications",
      ],
    });
  });

  it("opens Account for no tab, a tab that is gone, and a tab a member does not see", () => {
    const asked = [
      undefined,
      "billing",
      "people",
      "drive",
      "applications",
      "mail",
    ];

    expect({
      member: asked.map((tab) => openTab(tab, "member")),
      admin: asked.map((tab) => openTab(tab, "admin")),
    }).toStrictEqual({
      member: ["account", "account", "account", "account", "account", "mail"],
      admin: ["account", "account", "people", "drive", "applications", "mail"],
    });
  });
});

describe("loading Settings", () => {
  it("loads the open tab's slice alone for an admin", async () => {
    const admin = await adminMailbox("settings-admin", "Ada Admin");
    const request = await requestAs(admin);

    const loaded = await Promise.all(
      SETTINGS_TABS.map((tab) => loadSettings(db, env, admin, request, tab))
    );

    expect(
      loaded.map((settings) => ({
        tab: settings.tab,
        keys: keysOf(settings),
        me: settings.me,
      }))
    ).toStrictEqual(
      [
        ["account", ["account", "me", "signatures", "tab"]],
        ["mail", ["mail", "me", "tab"]],
        ["tasks", ["me", "tab", "tasks"]],
        ["people", ["me", "people", "tab"]],
        ["drive", ["drive", "me", "tab"]],
        ["branding", ["branding", "me", "tab"]],
        ["applications", ["applications", "me", "tab"]],
      ].map(([tab, keys]) => ({
        tab,
        keys,
        me: {
          id: admin.id,
          name: "Ada Admin",
          email: admin.email,
          role: "admin",
          lastSignInAt: admin.lastSignInAt,
        },
      }))
    );
  });

  it("loads a member's Account, and nothing of People or Drive, whatever the address asks for", async () => {
    const member = await mailbox("settings-member");
    const request = await requestAs(member);

    const loaded = await Promise.all(
      [undefined, "account", "people", "drive", "applications"].map((tab) =>
        loadSettings(db, env, member, request, tab)
      )
    );

    expect(
      loaded.map((settings) => ({ tab: settings.tab, keys: keysOf(settings) }))
    ).toStrictEqual(
      Array.from({ length: 5 }, () => ({
        tab: "account",
        keys: ["account", "me", "signatures", "tab"],
      }))
    );
  });

  it("loads Mail with its OpenPGP part, and Tasks with the GitHub connection", async () => {
    const member = await mailbox("settings-mail");
    const request = await requestAs(member);
    const mail = await loadSettings(db, env, member, request, "mail");
    const tasks = await loadSettings(db, env, member, request, "tasks");

    expect({
      mail: mail.tab === "mail" ? Object.keys(mail.mail).toSorted() : null,
      pgp: mail.tab === "mail" ? mail.mail.pgp : null,
      tasks: tasks.tab === "tasks" ? tasks.tasks : null,
    }).toStrictEqual({
      mail: [
        "filters",
        "imageSenders",
        "imports",
        "labels",
        "pgp",
        "preferences",
        "spam",
        "vacation",
      ],
      pgp: {
        own: null,
        peers: [],
        signByDefault: false,
        mailDomain: env.MAIL_DOMAIN,
      },
      tasks: { github: null },
    });
  });

  it("refuses People's, Drive's and the applications' slices to a member, even asked directly", async () => {
    const member = await mailbox("settings-sneak");

    const refusals = await Promise.all([
      rejection(peopleSettings(db, env, member)),
      rejection(driveSettings(db, member)),
      rejection(applicationsSettings(db, env, member)),
    ]);

    expect(refusals.map((error) => error?.message)).toStrictEqual([
      "Only an admin sees People.",
      "Only an admin sees Drive's settings.",
      "Only an admin sees the applications.",
    ]);
  });
});

describe("the forms of Mail, OpenPGP, Tasks and Drive", () => {
  it("saves Mail's preferences and refuses an intent Mail does not know", async () => {
    const user = await mailbox("settings-mail-forms");

    const saved = await mailSettingsIntent(
      db,
      env,
      user,
      formOf({ intent: "preferences", pageSize: "100" })
    );

    const label = await mailSettingsIntent(
      db,
      env,
      user,
      formOf({ intent: "label-create", name: "" })
    );

    const unknown = await mailSettingsIntent(
      db,
      env,
      user,
      formOf({ intent: "profile" })
    );

    expect({ saved, label: label.ok, unknown }).toStrictEqual({
      saved: { ok: true, message: "Saved." },
      label: false,
      unknown: { ok: false, error: "Unknown action." },
    });
  });

  it("refuses signing by default without a key, and an intent OpenPGP does not know", async () => {
    const user = await mailbox("settings-pgp-forms");

    const sign = await pgpIntent(
      db,
      env,
      user,
      formOf({ intent: "sign-default", on: "on" })
    );

    const unknown = await pgpIntent(
      db,
      env,
      user,
      formOf({ intent: "people" })
    );

    expect({ sign, unknown }).toStrictEqual({
      sign: { ok: false, error: "Make or import a key first." },
      unknown: { ok: false, error: "Unknown action." },
    });
  });

  it("disconnects GitHub for the person alone, and refuses an intent Tasks does not know", async () => {
    const user = await mailbox("settings-tasks-forms");

    const disconnected = await githubIntent(
      db,
      env,
      user,
      formOf({ intent: "disconnect" })
    );

    const unknown = await githubIntent(
      db,
      env,
      user,
      formOf({ intent: "connect-everyone" })
    );

    expect({
      disconnected,
      unknown,
      after: await tasksSettings(db, user),
    }).toStrictEqual({
      disconnected: {
        message:
          "Disconnected. The token is gone; your tasks stay, their issues untouched.",
      },
      unknown: { error: "Unknown action." },
      after: { github: null },
    });
  });

  it("lets an admin alone turn sharing outside the workspace off and on", async () => {
    const member = await mailbox("settings-drive-member");
    const admin = await adminMailbox("settings-drive-admin");

    const refused = await driveSettingsIntent(
      db,
      env,
      member,
      formOf({ intent: "external-sharing" })
    );

    const off = await driveSettingsIntent(
      db,
      env,
      admin,
      formOf({ intent: "external-sharing" })
    );

    const offShown = await driveSettings(db, admin);

    const on = await driveSettingsIntent(
      db,
      env,
      admin,
      formOf({ intent: "external-sharing", on: "on" })
    );

    const onShown = await driveSettings(db, admin);

    const unknown = await driveSettingsIntent(
      db,
      env,
      admin,
      formOf({ intent: "create" })
    );

    expect({
      refused,
      off,
      offShown: offShown.sharing.on,
      on,
      onShown: onShown.sharing.on,
      unknown,
    }).toStrictEqual({
      refused: { error: "Only an admin can change this." },
      off: {
        message:
          "Sharing outside the workspace is off. Existing links stay off until it is on again.",
      },
      offShown: false,
      on: { message: "Sharing outside the workspace is on." },
      onShown: true,
      unknown: { error: "Unknown action." },
    });
  });
});

describe("the Applications form", () => {
  it("lets an admin alone register an application, shows its secret once, and answers a mistake as the form's error", async () => {
    const member = await mailbox("settings-apps-member");
    const admin = await adminMailbox("settings-apps-admin");

    const fields = {
      intent: "create",
      name: "Wiki",
      redirectUris: "https://wiki.example.com/callback",
      access: "everyone",
      pkceRequired: "on",
    };

    const refused = await applicationsIntent(db, env, member, formOf(fields));
    const made = await applicationsIntent(db, env, admin, formOf(fields));

    const mistake = await applicationsIntent(
      db,
      env,
      admin,
      formOf({ ...fields, redirectUris: "http://wiki.example.com/callback" })
    );

    const shown = await applicationsSettings(db, env, admin);
    const wiki = shown.applications.find((app) => app.name === "Wiki");

    expect({
      refused,
      secret: made.password?.startsWith("wss_"),
      mistake,
      wiki: wiki && {
        redirectUris: wiki.redirectUris,
        access: wiki.access,
        members: wiki.members,
      },
      secretShown: JSON.stringify(shown).includes(made.password ?? "wss_"),
    }).toStrictEqual({
      refused: { error: "Only an admin can change this." },
      secret: true,
      mistake: {
        error:
          '"http://wiki.example.com/callback" must use https (http only on localhost).',
      },
      wiki: {
        redirectUris: ["https://wiki.example.com/callback"],
        access: "everyone",
        members: [],
      },
      secretShown: false,
    });
  });
});
