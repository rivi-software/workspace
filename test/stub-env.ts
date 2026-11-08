/**
 * A test's `Env`: what the caller spreads in (the test worker's own bindings and vars, or a few vars alone) with some
 * replaced by stubs. A stub implements only what the code under test calls, so the object is no whole `Env` to the
 * compiler.
 *
 * SAFETY: test-only. A stub that lacks a method the code under test calls fails the test with a TypeError, and a
 * binding or var the caller leaves out reads as undefined, as an unset one does in a Worker.
 */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- a stub's values have no contract the compiler can check, by design (SAFETY above)
export const stubEnv = (bindings: { [K in keyof Env]?: unknown }): Env =>
  bindings as Env;
