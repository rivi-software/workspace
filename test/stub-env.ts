/**
 * A test's `Env`: what the caller spreads in (the test worker's own bindings and vars, or a few vars alone) with some
 * replaced by stubs. A stub implements only what the code under test calls, so the object is no whole `Env` to the
 * compiler.
 *
 * SAFETY: test-only. A stub that lacks a method the code under test calls fails the test with a TypeError, and a
 * binding or var the caller leaves out reads as undefined, as an unset one does in a Worker.
 */
export const stubEnv = <const Bindings extends { [K in keyof Env]?: unknown }>(
  bindings: Bindings
): Env => bindings as Env;
