/** Why a Duo sign-in step failed: `code` names the step (the Auth API's own error codes and this package's), `message` says what. */
export class DuoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "DuoError";
  }
}
