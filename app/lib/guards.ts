/** The message of anything a `catch` can hold, so no caller asserts it to `Error`. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a catch clause holds whatever was thrown; only an Error's message is read, anything else is stringified
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A value a query or invariant guarantees; throws, naming it, when it is missing. */
export const defined = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what} to exist`);
  }

  return value;
};

/** The object a stored JSON text holds, or `{}` for text that is unreadable or holds no object. Its values stay `unknown` until a reader checks each one. */
export const parseJsonObject = (json: string | null | undefined) => {
  try {
    const parsed = json ? JSON.parse(json) : {};
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- stored JSON is untrusted: only an object is read, key by key
    const isObject = Boolean(parsed) && typeof parsed === "object";

    // SAFETY: an object read from JSON is a dictionary of its keys; every value is checked by the reader that takes it.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the values stay unknown until a reader checks them
    return isObject ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Whether a parsed JSON value is an object (an array too), whose members can then be read by name, each still `unknown`. */
export const isJsonObject = (
  value: unknown
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the members stay unknown until a reader checks each one
): value is Record<string, unknown> =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the parsed value's type is what is being decided
  typeof value === "object" && value !== null;

/** A stored value that is a string, else null. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a value read from stored JSON is untrusted: only a string is kept, anything else is null
export const stringOrNull = (value: unknown): string | null =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the stored value's type is what is being decided
  typeof value === "string" ? value : null;

/** A stored value that is a number, else `fallback`. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a value read from stored JSON is untrusted: only a number is kept, anything else is the fallback
export const numberOr = (value: unknown, fallback: number): number =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the stored value's type is what is being decided
  typeof value === "number" ? value : fallback;

/** The strings of a stored array; anything else, and any entry that is not a string, is left out. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- a value read from stored JSON is untrusted: only an array's strings are kept
export const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? // oxlint-disable-next-line anti-slop/no-runtime-typeof -- an entry of stored JSON is untrusted: only a string is kept
      value.filter((entry): entry is string => typeof entry === "string")
    : [];
