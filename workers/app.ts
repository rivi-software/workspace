import { setSecretPaths } from "@rivi-software/posthog-tanstack-start/server";
import handler from "@tanstack/react-start/server-entry";

import { SECRET_PATHS } from "~/lib/posthog-config";

import { createWorker } from "./worker";

// An exception on a link's page reports `/s/$token`, never the token.
setSecretPaths(SECRET_PATHS);

// The Worker (`workers/worker.ts`) with TanStack Start behind it.
export default createWorker((request) => handler.fetch(request));
