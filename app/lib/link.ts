/**
 * Calls to another service that must never fail the page asking (GitHub for Tasks), and the links such an answer
 * carries, fit to render.
 */

/**
 * A call that never fails the page asking: its answer, or null when the service throws or has not answered within
 * `ms`. What it adds to a page (a list, a card) can be left out; a failure is logged as `link.failed` with the
 * call's name and nothing of what was asked.
 */
export const callLink = async <T>(
  name: string,
  call: () => Promise<T>,
  ms = 2000
): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  // oxlint-disable-next-line promise/avoid-new -- bridges setTimeout to a Promise for race timeout
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        JSON.stringify({
          event: "link.failed",
          link: name,
          error: `no answer in ${ms} ms`,
        })
      );
      resolve(null);
    }, ms);
  });

  try {
    return await Promise.race([call(), late]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({ event: "link.failed", link: name, error: message })
    );

    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A link another service sent, fit to render: an absolute http(s) URL, else undefined (an anchor without an href).
 * Anything else in an answer is a fault, and a `javascript:` link from it would run on this app's origin.
 */
export const linkHref = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);

    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
};
