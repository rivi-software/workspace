import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Lock,
  LockOpen,
  ShieldCheck,
  ShieldQuestionMark,
  ShieldX,
} from "lucide-react";
import { useState } from "react";

import { recheckPgpAction } from "~/lib/mail/pgp/actions";
import {
  groupedFingerprint,
  shortKeyId,
  sourceWords,
} from "~/lib/mail/pgp/pgp";
import type { PgpStatus } from "~/lib/mail/pgp/pgp";
import type { MessageData } from "~/lib/mail/reads";

import { Button, Pill } from "./ui";

/** The pill beside the sender's name: how the message was protected, at a glance. */
export const PgpPill = ({ pgp }: { pgp: PgpStatus }) => {
  const state = pgp.signature?.state;

  if (pgp.encrypted && !pgp.decrypted) {
    return (
      <Pill tone="amber">
        <LockOpen className="h-3 w-3" />
        Encrypted
      </Pill>
    );
  }

  if (state === "bad") {
    return (
      <Pill tone="red">
        <ShieldX className="h-3 w-3" />
        Bad signature
      </Pill>
    );
  }

  if (pgp.encrypted) {
    return (
      <Pill tone={state === "good" ? "accent" : "neutral"}>
        <Lock className="h-3 w-3" />
        Encrypted
      </Pill>
    );
  }

  if (state === "good") {
    return (
      <Pill tone="accent">
        <ShieldCheck className="h-3 w-3" />
        Signed
      </Pill>
    );
  }

  return pgp.signature ? (
    <Pill tone="amber">
      <ShieldQuestionMark className="h-3 w-3" />
      Signed
    </Pill>
  ) : null;
};

/** What the signature says, in a sentence. */
const signatureWords = (m: MessageData, pgp: PgpStatus): string | null => {
  const sig = pgp.signature;

  if (!sig) {
    return null;
  }

  if (m.direction === "outbound") {
    return "Signed with your key.";
  }

  switch (sig.state) {
    case "good": {
      return `Signed by ${m.from.email}, checked with ${sourceWords(sig.source)}.`;
    }

    case "bad": {
      return `The signature does not check out${sig.reason ? ` (${sig.reason})` : ""}: the message may have been changed after it was signed.`;
    }

    case "other-address": {
      return `Signed with a key that names other addresses than ${m.from.email}.`;
    }

    default: {
      return `Signed with the key ${shortKeyId(sig.keyId)}, which no key at hand for ${m.from.email} can check.`;
    }
  }
};

/** What encryption did, in a sentence. */
const encryptionWords = (m: MessageData, pgp: PgpStatus): string | null => {
  if (!pgp.encrypted) {
    return null;
  }

  if (!pgp.decrypted) {
    return (
      pgp.error ?? "This message is encrypted, and your key could not open it."
    );
  }

  return m.direction === "outbound"
    ? "Sent encrypted."
    : "Encrypted to you, and opened with your key.";
};

/** The notice's icon: a broken signature first, then encryption, then a signature. */
const NoticeIcon = ({ pgp }: { pgp: PgpStatus }) => {
  if (pgp.signature?.state === "bad") {
    return <ShieldX className="text-red h-3.5 w-3.5" />;
  }

  return pgp.encrypted ? (
    <Lock className="h-3.5 w-3.5" />
  ) : (
    <ShieldCheck className="h-3.5 w-3.5" />
  );
};

/**
 * The line above an open message that arrived or went out with OpenPGP: whether it was encrypted and whose signature
 * it carries. Where a key added since could change the answer (a signature no key could check, a message that stayed
 * shut), "Check again" opens the message anew.
 */
export const PgpNotice = ({ message: m }: { message: MessageData }) => {
  const router = useRouter();
  const recheck = useServerFn(recheckPgpAction);
  const [checking, setChecking] = useState(false);
  const [unchanged, setUnchanged] = useState(false);
  const { pgp } = m;

  if (!pgp) {
    return null;
  }

  const words = [encryptionWords(m, pgp), signatureWords(m, pgp)]
    .filter(Boolean)
    .join(" ");

  const state = pgp.signature?.state;

  const again =
    m.direction === "inbound" &&
    m.hasRaw &&
    ((pgp.encrypted && !pgp.decrypted) ||
      state === "unknown-key" ||
      state === "other-address");

  return (
    <div className="border-line bg-sidebar text-muted print-hidden mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-1.5 text-sm">
      <NoticeIcon pgp={pgp} />
      <span
        className="flex-1"
        title={
          pgp.signature?.fingerprint
            ? groupedFingerprint(pgp.signature.fingerprint)
            : undefined
        }
      >
        {words}
        {unchanged && " Still the same with the keys at hand."}
      </span>
      {again && (
        <Button
          size="sm"
          loading={checking}
          onClick={async () => {
            setChecking(true);
            let same = false;

            try {
              const result = await recheck({ data: { messageId: m.id } });
              same = JSON.stringify(result.pgp) === JSON.stringify(pgp);
              await router.invalidate({ sync: true });
            } catch {
              // The look failed: the notice stays as it was, and the button can be pressed again.
            }

            setUnchanged(same);
            setChecking(false);
          }}
        >
          Check again
        </Button>
      )}
    </div>
  );
};
