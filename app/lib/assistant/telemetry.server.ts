import { captureServerEvent } from "@rivi-software/posthog-tanstack-start/server";
import { registerTelemetry } from "ai";

import { aiCallOptions, createAiTelemetry } from "~/lib/ai-telemetry";
import type { AiRunContext } from "~/lib/ai-telemetry";

/**
 * The AI SDK's telemetry options of an Assistant turn: its conversation is the AI session, the person the distinct
 * id, as they are PostHog persons by their user id.
 *
 *   streamText({ model, messages, ...assistantTelemetry({ conversationId, distinctId: user.id }) })
 */
export const assistantTelemetry = (context: AiRunContext) =>
  aiCallOptions("assistant", context);

/** Whether the events carry what was asked and answered (`AI_TEXT_ANALYTICS`), as the last env read said. */
let text = false;

/**
 * The Assistant in PostHog AI observability (`app/lib/ai-telemetry`): each turn a trace under its
 * conversation, with every step's generation and each tool's span under the step that called it, and, where
 * `AI_TEXT_ANALYTICS` is `on`, the question, each step's prompt and answer and the tools' arguments and results,
 * credentials masked. That is the person's mail and files as the tools read them, so PostHog deletes it after 30
 * days; the rest is counts, names and ids. Server-side only: the browser's PostHog stays error tracking alone
 * (`app/lib/posthog-config.ts`).
 */
const telemetry = createAiTelemetry({
  capture: ({ event, distinctId, properties, anonymousId }) =>
    captureServerEvent(event, distinctId, properties, anonymousId),
  text: () => text,
});

const REGISTERED = Symbol.for("workspace.posthog-ai-telemetry");

/**
 * Registers the integration once per isolate (module reloads in dev would otherwise add it again), and takes the
 * text switch from the env the turn runs with (`assistantModel`).
 */
export const registerAssistantTelemetry = (
  env: Pick<Env, "AI_TEXT_ANALYTICS">
) => {
  text = String(env.AI_TEXT_ANALYTICS) === "on";

  // SAFETY: the registration flag is the only key this module adds to the global.
  const g = globalThis as { [REGISTERED]?: boolean };

  if (g[REGISTERED]) {
    return;
  }

  g[REGISTERED] = true;
  registerTelemetry(telemetry.integration);
};
