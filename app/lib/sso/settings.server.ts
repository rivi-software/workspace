/**
 * Settings → Applications, an admin's (single sign-on, docs/SSO.md): the applications that sign people in through the
 * workspace, who may sign in to each, the key tokens are signed with, the provider's addresses, and whether Duo
 * confirms password sign-ins. What the tab loads (`applicationsSettings`) and what its forms do
 * (`applicationsIntent`), apart from the server function so the tests call both.
 */
import { and, asc, eq } from "drizzle-orm";

import type { Database } from "~/db";
import { users } from "~/db/schema";
import type { User } from "~/db/schema";
import { duoEnabled } from "~/lib/duo.server";
import { field } from "~/lib/guards";
import type { SettingsResult } from "~/lib/settings";

import {
  SsoAdminError,
  createClient,
  listClientMembers,
  listClients,
  removeClientMember,
  rotateClientSecret,
  setClientActive,
  setClientMember,
  updateClient,
} from "./clients.server";
import type { SsoClientInput } from "./clients.server";
import { listSigningKeys, rotateSigningKey } from "./keys.server";
import { SSO_PATHS } from "./paths";
import { issuerOf } from "./provider.server";

/** What the Applications tab shows an admin; it refuses anyone else, whom Settings never shows the tab (`openTab`). */
export const applicationsSettings = async (
  db: Database,
  env: Env,
  user: User
) => {
  if (user.role !== "admin") {
    throw new Error("Only an admin sees the applications.");
  }

  const [clients, signingKeys, people] = await Promise.all([
    listClients(db),
    listSigningKeys(db),
    db.query.users.findMany({
      columns: { id: true, name: true, email: true },
      where: and(eq(users.active, true), eq(users.kind, "person")),
      orderBy: [asc(users.name)],
    }),
  ]);

  const applications = await Promise.all(
    clients.map(async (client) => ({
      ...client,
      members: await listClientMembers(db, client.id),
    }))
  );

  const issuer = issuerOf(env);

  return {
    applications,
    signingKeys,
    people,
    endpoints: {
      issuer,
      discovery: `${issuer}${SSO_PATHS.discovery}`,
      authorize: `${issuer}${SSO_PATHS.authorize}`,
      token: `${issuer}${SSO_PATHS.token}`,
      jwks: `${issuer}${SSO_PATHS.jwks}`,
      userinfo: `${issuer}${SSO_PATHS.userinfo}`,
      logout: `${issuer}${SSO_PATHS.logout}`,
    },
    duo: duoEnabled(env),
  };
};

const clientInput = (form: FormData): SsoClientInput => ({
  name: field(form, "name"),
  redirectUris: field(form, "redirectUris"),
  postLogoutRedirectUris: field(form, "postLogoutRedirectUris"),
  launchUrl: field(form, "launchUrl"),
  pkceRequired: form.get("pkceRequired") === "on",
  access: field(form, "access") === "listed" ? "listed" : "everyone",
});

const audit = (event: string, by: string, details: Record<string, string>) => {
  console.log(JSON.stringify({ event, by, ...details }));
};

// oxlint-disable-next-line eslint/complexity -- one form, one case per intent, each a call into the clients module
const applicationsAction = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  const intent = field(form, "intent");
  const id = field(form, "id");

  switch (intent) {
    case "create": {
      const { client, secret } = await createClient(
        db,
        user,
        clientInput(form)
      );

      audit("sso.client-created", user.id, { client: client.id });

      return {
        message: `${client.name} is registered as ${client.id}. Copy its secret now; it is not shown again:`,
        password: secret,
      };
    }

    case "update": {
      await updateClient(db, id, clientInput(form));

      audit("sso.client-updated", user.id, { client: id });

      return { message: "Saved." };
    }

    case "rotate": {
      const secret = await rotateClientSecret(db, id);

      audit("sso.client-secret-rotated", user.id, { client: id });

      return {
        message:
          "A new secret; the old one has stopped working. Copy it now; it is not shown again:",
        password: secret,
      };
    }

    case "activate":
    case "deactivate": {
      const active = intent === "activate";
      await setClientActive(db, id, active);

      audit(`sso.client-${intent}d`, user.id, { client: id });

      return {
        message: active
          ? "Reactivated: it signs people in again."
          : "Deactivated: its sign-ins and codes stop at once. Its registration stays.",
      };
    }

    case "member-set": {
      const userId = field(form, "userId");
      await setClientMember(db, user, id, userId, field(form, "role"));

      audit("sso.member-set", user.id, { client: id, person: userId });

      return { message: "On the list." };
    }

    case "member-remove": {
      const userId = field(form, "userId");
      await removeClientMember(db, id, userId);

      audit("sso.member-removed", user.id, { client: id, person: userId });

      return { message: "Off the list: their next sign-in is refused." };
    }

    case "rotate-key": {
      const key = await rotateSigningKey(db, env);

      audit("sso.signing-key-rotated", user.id, { kid: key.kid });

      return {
        message:
          "A new signing key. Tokens signed with the previous one verify for another day.",
      };
    }

    default: {
      return { error: "Unknown action." };
    }
  }
};

/** The Applications forms, for an admin only; a mistake the admin can correct is answered as the form's error. */
export const applicationsIntent = async (
  db: Database,
  env: Env,
  user: User,
  form: FormData
): Promise<SettingsResult> => {
  if (user.role !== "admin") {
    return { error: "Only an admin can change this." };
  }

  try {
    return await applicationsAction(db, env, user, form);
  } catch (error) {
    if (error instanceof SsoAdminError) {
      return { error: error.message };
    }

    throw error;
  }
};
