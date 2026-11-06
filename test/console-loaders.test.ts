import { describe, expect, it } from "vitest";

/**
 * The console's route files as written. A route module cannot load in the test pool (its server functions and
 * `request.server.ts` need Start's Vite build), so this reads what each loader calls instead.
 */
const sources = import.meta.glob<string>("../app/routes/_app/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

const ROUTE_FILE = /(?<name>[^/]+)\.tsx$/u;

// Oxfmt writes a route's options two spaces in: the loader runs to the next option or the end of the object.
const LOADER = /^ {2}loader:(?<loader>[\s\S]*?)(?=^ {2}\w+:|^\}\);)/mu;
const SERVER_FN = /const (?<name>\w+) = createServerFn\(/gu;

/** The route files under `/_app` by name (`drive.f.$folderId`), `route` being the console's own layout. */
const routes = new Map(
  Object.entries(sources).map(([path, source]) => [
    ROUTE_FILE.exec(path)?.groups?.name ?? path,
    source,
  ])
);

/** The arguments of each call to `name` in `code`, read to the matching parenthesis. */
const callsOf = (code: string, name: string): string[] => {
  const calls: string[] = [];
  let from = code.indexOf(`${name}(`);

  while (from !== -1) {
    const open = from + name.length;
    let depth = 0;
    let end = open;

    for (; end < code.length; end += 1) {
      if (code[end] === "(") {
        depth += 1;
      } else if (code[end] === ")") {
        depth -= 1;

        if (depth === 0) {
          break;
        }
      }
    }

    calls.push(code.slice(open + 1, end));
    from = code.indexOf(`${name}(`, end);
  }

  return calls;
};

const loaders = [...routes].flatMap(([name, source]) => {
  const loader = LOADER.exec(source)?.groups?.loader;

  const serverFns = [...source.matchAll(SERVER_FN)].flatMap(
    (match) => match.groups?.name ?? []
  );

  return loader === undefined ? [] : [{ name, loader, serverFns, source }];
});

/** The layouts above a route in `/_app`: `drive.sign.new` and `drive.sign` and `drive` for `drive.sign.new.$nodeId`. */
const layoutsOf = (name: string): string[] =>
  name
    .split(".")
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join("."));

describe("a console loader whose minute's refresh fails (#3547, #3548)", () => {
  it("reads every section's loader", () => {
    expect(loaders.map(({ name }) => name)).toStrictEqual(
      expect.arrayContaining([
        "route",
        "mail",
        "mail.t.$threadId",
        "mail.compose",
        "drive.index",
        "drive.f.$folderId",
        "drive.d.$nodeId",
        "drive.sign.index",
        "drive.sign.new.$nodeId",
        "drive.sign.r.$requestId",
        "calendar",
        "tasks",
        "assistant.c.$conversationId",
        "settings",
      ])
    );
  });

  it.each(loaders)(
    "$name answers with the view the page shows when loading it again fails",
    ({ loader }) => {
      expect(loader).toContain("keepShown(run, ");
    }
  );

  it.each(loaders)(
    "$name calls its server functions with the fetch that names a failed call",
    ({ loader, serverFns }) => {
      const calls = serverFns.flatMap((serverFn) => callsOf(loader, serverFn));

      expect(calls.length).toBeGreaterThan(0);

      for (const call of calls) {
        expect(call).toContain("fetch: serverFnFetch");
      }
    }
  );

  it.each(loaders.filter(({ name }) => name !== "route"))(
    "$name fails a first load into an error state inside the console, not the root error page",
    ({ name, source }) => {
      const caught = [
        source,
        ...layoutsOf(name).map((layout) => routes.get(layout)),
      ]
        .filter((code) => code !== undefined)
        .some((code) => code.includes("errorComponent:"));

      expect(caught).toBeTruthy();
    }
  );
});
