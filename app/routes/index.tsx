import { createFileRoute, redirect } from "@tanstack/react-router";

/** Mail is the first module; the root goes there. */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/mail" });
  },
});
