/**
 * PostHog AI observability for the AI SDK: one trace per request, with each model call, tool and embedding nested
 * where it ran, and its prompts and answers behind a switch. Registered by `app/lib/assistant/telemetry.server.ts`.
 */
export {
  aiCallOptions,
  createAiTelemetry,
  type AiCall,
  type AiEvent,
  type AiProperties,
  type AiRunContext,
  type AiTelemetry,
  type AiTelemetryOptions,
  type AiTraceText,
  type AiValue,
} from "./telemetry";

export { INPUT_LIMIT, REDACTED, TEXT_LIMIT, maskCredentials } from "./text";
