// The Worker the tests reach as `exports.default` (`cloudflare:workers`): the production one (`workers/worker.ts`),
// with a stand-in for TanStack Start, which needs the Vite build.
import { createWorker } from "../workers/worker";

export default createWorker(
  () =>
    new Response("TanStack Start is not served in the tests", { status: 404 })
);
