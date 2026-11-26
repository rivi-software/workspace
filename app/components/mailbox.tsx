/**
 * Which mailbox Mail shows: the person's own, or a shared group inbox (`box` in Mail's search params). The mail
 * layout provides it; every server function a Mail component calls passes it on (`box` in its data or form), and the
 * server checks it again (`mailContext`), so a stale or forged one acts on nothing the person cannot open.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

const MailboxContext = createContext<string | undefined>(undefined);

export const MailboxProvider = ({
  box,
  children,
}: {
  box: string | undefined;
  children: ReactNode;
}) => <MailboxContext.Provider value={box}>{children}</MailboxContext.Provider>;

/** The shared group inbox Mail shows, or undefined for the person's own. */
export const useMailbox = (): string | undefined => useContext(MailboxContext);

/** A form for a Mail server function, naming the mailbox it acts in when it is a group's. */
export const inMailbox = (
  form: FormData,
  box: string | undefined
): FormData => {
  if (box) {
    form.set("box", box);
  }

  return form;
};
