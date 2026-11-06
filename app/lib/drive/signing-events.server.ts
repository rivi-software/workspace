/**
 * A signing request's history (#2974): every step it took, with who took it and the address and browser it came from,
 * which the certificate page and the request's page show. The module that moves a request (`signing.server.ts`)
 * writes it through `record`.
 */
import type { Database } from "~/db";
import { signingEvents } from "~/db/schema";
import type { SigningRequest } from "~/db/schema";

import { newId } from "../ids";

/** Where a step came from: the address and browser the certificate records. */
export interface Origin {
  ip: string | null;
  userAgent: string | null;
}

export const originOf = (request: Request): Origin => ({
  ip: request.headers.get("cf-connecting-ip"),
  userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
});

/** The customer as an event names them. */
export const customerOf = (r: SigningRequest) => ({
  name: `${r.customerName} <${r.customerEmail}>`,
});

export const record = async (
  db: Database,
  requestId: string,
  kind: string,
  actor: { userId?: string | null; name: string },
  origin: Origin | null,
  at: number,
  detail?: string
) => {
  await db.insert(signingEvents).values({
    id: newId("se"),
    requestId,
    kind,
    userId: actor.userId ?? null,
    actor: actor.name,
    ip: origin?.ip ?? null,
    userAgent: origin?.userAgent ?? null,
    detail: detail ?? null,
    createdAt: new Date(at).toISOString(),
  });
};
