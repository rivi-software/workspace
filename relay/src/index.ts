/** The relay's Worker (README): every request through `handleRelay`. */
import { handleRelay } from "./relay";
import type { RelayEnv } from "./relay";

export default {
  fetch: (request: Request, env: RelayEnv): Promise<Response> =>
    handleRelay(request, env),
};
