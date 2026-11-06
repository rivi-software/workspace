/** Microsoft did not answer as it should; `retryAfter` (seconds) when it asked to be left alone for a while. */
export class GraphError extends Error {
  override name = "GraphError";

  readonly status: number;
  readonly retryAfter: number | null;

  constructor(message: string, status: number, retryAfter: number | null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
