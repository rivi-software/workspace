/**
 * Work through a batch the cron selects again each minute (#2653), one item at a time, going on past one that fails.
 * Such a batch is read in the same order every run, so a failing item would come first again each minute and the items
 * after it would never get their turn, in every person's drive or mailbox at once. Answers how many items `step`
 * answered true for, and what failed, which the caller throws with `throwFailures` once the whole run is done.
 */
export const eachOf = async <T>(
  items: readonly T[],
  step: (item: T) => Promise<boolean>
): Promise<{ done: number; failures: unknown[] }> => {
  let done = 0;
  const failures: unknown[] = [];

  for (const item of items) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time: each step reads what the one before changed
      if (await step(item)) {
        done += 1;
      }
    } catch (error) {
      failures.push(error);
    }
  }

  return { done, failures };
};

/** Throw what a run's batches could not do, after every item had its turn, so the cron's `try` reports it. */
export const throwFailures = (what: string, failures: unknown[]): void => {
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `${what} failed on ${failures.length}, the first with ${String(failures[0])}`
    );
  }
};
