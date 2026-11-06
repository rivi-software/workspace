import type { ReactNode } from "react";

import { RiviMark } from "~/components/brand";

/** The card a signed-out page's form sits on. */
export const authCardClass =
  "space-y-4 rounded-xl border border-line bg-elevated p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-12px_rgb(0_0_0/0.12)]";

/** The frame of the pages a person sees before they are signed in: the mark, the app's name and a line under it. */
export const AuthShell = ({
  appName,
  subtitle,
  children,
}: {
  appName: string;
  subtitle: ReactNode;
  children: ReactNode;
}) => (
  <main className="bg-sidebar flex min-h-dvh items-center justify-center p-6">
    <div className="animate-fade-in w-full max-w-[360px]">
      <div className="mb-6 flex items-center gap-2.5">
        <RiviMark className="text-[32px]" />
        <div>
          <h1 className="text-md leading-tight font-semibold">{appName}</h1>
          <p className="text-muted text-sm">{subtitle}</p>
        </div>
      </div>
      {children}
    </div>
  </main>
);
