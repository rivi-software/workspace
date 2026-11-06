import { useNewBuildNotice } from "@rivi-software/deploy-watch/react";

import { Button } from "./ui";

/**
 * Once a deploy has replaced the build this tab runs (CORE-1169, `@rivi-software/deploy-watch`): one line and
 * Later / Reload, floating at the bottom right. It takes no focus; a screen
 * reader hears it once. Later hides it, and the tab still moves onto the new build at its next move to
 * another page, which loses no more than that move would. Reload is the person's own moment: a message
 * being written goes with the page unless its draft was saved, as on any reload.
 */
export const NewVersionNotice = () => {
  const notice = useNewBuildNotice();

  if (!notice.show) {
    return null;
  }

  return (
    <output
      aria-label="New version"
      data-new-version-notice
      className="animate-rise-in border-line bg-elevated text-fg shadow-pop bottom-dock fixed right-4 z-50 block w-[min(22rem,calc(100vw-2rem))] rounded-lg border p-3 text-base print:hidden"
    >
      <p className="text-pretty">
        A new version of Workspace is ready. It loads when you open another
        page, or you can reload now.
      </p>
      <div className="mt-3 flex justify-end gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            notice.dismiss();
          }}
        >
          Later
        </Button>
        <Button
          size="sm"
          onClick={() => {
            notice.reload();
          }}
        >
          Reload
        </Button>
      </div>
    </output>
  );
};
