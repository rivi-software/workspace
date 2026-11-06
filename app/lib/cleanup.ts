/**
 * Runs `work`, then `cleanup`, whatever `work` did: the `try`/`finally` a component wants around a pending state,
 * kept out of the component because React Compiler cannot compile it there.
 */
export const withCleanup = async <T>(
  work: () => Promise<T>,
  cleanup: () => void
): Promise<T> => {
  try {
    return await work();
  } finally {
    cleanup();
  }
};
