/**
 * Whether the workspace's AI features are on: `AI_FEATURES` in `wrangler.jsonc`, on unless it is `off`. Off, the
 * Assistant answers nothing (its console route and `/api/v1/assistant/*` refuse) and the console shows no way to it,
 * so no person's mail or files reach a model. A plain module, so the server and what the pages render read one rule.
 */
export const aiEnabled = (env: Pick<Env, "AI_FEATURES">): boolean => {
  // The vars are typed from wrangler.jsonc as literals; a deployment sets any string, or none (a stub env).
  const value: string | undefined = env.AI_FEATURES;

  return (value ?? "").trim().toLowerCase() !== "off";
};

/** What a request to the Assistant is told while AI is off. */
export const AI_OFF = "The Assistant is off in this workspace.";
