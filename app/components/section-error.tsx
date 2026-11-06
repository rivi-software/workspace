import { useChunkErrorRecovery } from "@rivi-software/deploy-watch/react";
import { useRouter } from "@tanstack/react-router";
import { CloudOff } from "lucide-react";

import { Button, Empty } from "~/components/ui";
import { errorMessage } from "~/lib/guards";

/**
 * What takes a section's place in the console when its loader fails and there is nothing to keep (#3547, #3548): a
 * first load, another folder, file or conversation. A failed reload of the view on screen never gets here: the
 * loader's `keepShown` answers with what the page shows. The sidebar stays, and Try again loads again. The router has
 * already reported the error (`defaultOnCatch`); a chunk a deploy removed reloads the page instead (CORE-1169).
 *
 * Each section's route sets it as its own `errorComponent`, which the server renders too when the first load fails
 * there; a layout's would only catch the error in the browser.
 */
export const SectionError = ({
  error,
  title,
}: {
  /** What the loader or the render threw (`ErrorComponentProps`' `error`). */
  error: unknown;
  /** "Calendar didn't load". */
  title: string;
}) => {
  const router = useRouter();

  if (useChunkErrorRecovery(error)) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <Empty
        icon={<CloudOff className="h-4 w-4" />}
        title={title}
        action={
          // A loader's error resets once the router loads again.
          <Button onClick={() => router.invalidate()}>Try again</Button>
        }
      >
        {import.meta.env.DEV ? (
          // A server function's path in development is a long id without a break.
          <span className="break-all">{errorMessage(error)}</span>
        ) : (
          "The server's answer didn't come through."
        )}
      </Empty>
    </div>
  );
};
