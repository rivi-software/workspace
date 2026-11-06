/**
 * The Deploy workflow's guards (.github/workflows/deploy.yml) on the build in dist/server, from
 * `@rivi-software/cloudflare-deploy`:
 *
 *   node scripts/deploy-checks.mjs before   after the build, before anything reaches Cloudflare
 *   node scripts/deploy-checks.mjs after    once `wrangler deploy` is done
 *
 * `before` refuses a run of the workflow on any branch but main (a manual run can pick any branch), and a build whose
 * D1 or KV ids are still the placeholders of wrangler.jsonc: the migrations would otherwise run first, and the deploy
 * fail after them. `after` waits for APP_URL to answer /api/health, so a deploy that does not serve, or an APP_URL that
 * names the wrong address (every link in a mail and every passkey goes by it), fails the run.
 */
import { readFile } from "node:fs/promises";

import {
  assertDeployedBindings,
  assertProductionBuildBranch,
  checkDeploymentHealth,
} from "@rivi-software/cloudflare-deploy";

const CONFIG = "dist/server/wrangler.json";

// assertDeployedBindings refuses an all-zero id; PREVIOUS_ASSETS ships with this one so that Miniflare keeps it apart
// from KV's.
const PREVIOUS_ASSETS_PLACEHOLDER = "00000000000000000000000000000001";

const before = async (config) => {
  assertProductionBuildBranch();

  const unset = (config.kv_namespaces ?? [])
    .filter((namespace) => namespace.id === PREVIOUS_ASSETS_PLACEHOLDER)
    .map(
      (namespace) =>
        `  kv_namespaces[${namespace.binding}].id = "${namespace.id}"`
    );

  try {
    await assertDeployedBindings(CONFIG);
  } catch (error) {
    // The other placeholders join the list, above the line that ends it.
    const lines = error.message.split("\n");

    lines.splice(-1, 0, ...unset);

    throw new Error(lines.join("\n"), { cause: error });
  }

  if (unset.length > 0) {
    throw new Error(
      [`${CONFIG} has placeholder binding ids:`, ...unset].join("\n")
    );
  }

  console.log(`${CONFIG} is ready to deploy.`);
};

const after = async (config) => {
  const origin = config.vars?.APP_URL;

  try {
    await checkDeploymentHealth(origin, {
      paths: ["/api/health"],
      validate: async (response) => {
        const body = await response.json();

        if (body?.ok !== true) {
          throw new Error(`/api/health answered ${JSON.stringify(body)}`);
        }
      },
    });
  } catch (error) {
    throw new Error(
      `${origin}/api/health did not answer after the deploy (${error.message}). Is APP_URL in wrangler.jsonc the Worker's address?`,
      { cause: error }
    );
  }

  console.log(`${origin} answers.`);
};

const steps = { after, before };
const step = steps[process.argv[2]];

if (!step) {
  console.error("Usage: node scripts/deploy-checks.mjs before|after");
  process.exit(2);
}

try {
  await step(JSON.parse(await readFile(CONFIG, "utf-8")));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
