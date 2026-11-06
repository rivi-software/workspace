import {
  posthogFunctionErrors,
  posthogRequestErrors,
} from "@rivi-software/posthog-tanstack-start/start";
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";

export const startInstance = createStart(() => ({
  // Declaring a Start instance replaces the built-in server function CSRF protection, so it is added back explicitly.
  requestMiddleware: [
    createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === "serverFn" }),
    posthogRequestErrors,
  ],
  functionMiddleware: [posthogFunctionErrors],
}));
