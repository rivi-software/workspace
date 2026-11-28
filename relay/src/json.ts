/** Reading JSON nobody vouches for (a request's body, a token's claims, an answer from Apple or Google) one member at a time. */

/** The members of a JSON text's object by name, each still `unknown`; `{}` for text that is unreadable or holds no object. */
export const parseJsonObject = (json: string) => {
  try {
    const parsed: unknown = JSON.parse(json);
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- untrusted JSON: only an object is read, member by member
    const isObject = Boolean(parsed) && typeof parsed === "object";

    // SAFETY: an object read from JSON is a dictionary of its keys; every value is checked by the reader that takes it.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the values stay unknown until a reader checks them
    return isObject ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** A JSON member that is a string, else null. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a member of untrusted JSON: only a string is kept
export const stringOrNull = (value: unknown): string | null =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the member's type is what is being decided
  typeof value === "string" ? value : null;

/** A JSON member that is a finite number, else null. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a member of untrusted JSON: only a number is kept
export const numberOrNull = (value: unknown): number | null =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the member's type is what is being decided
  typeof value === "number" && Number.isFinite(value) ? value : null;
