import { env } from "cloudflare:workers";

import { namespaceOf } from "~/lib/search/index.server";
import type { SearchEntry, SearchIndex } from "~/lib/search/index.server";

/** The words of a text that carry its meaning for the stand-in: lower-case, four letters or more ("the" and "for" say nothing). */
const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3)
  );

/**
 * An in-memory index for the tests, in place of Workers AI and Vectorize: an entry is the set of its words, and a
 * question finds the entries that share words with it, the most shared first (the cosine of the two sets). It keeps
 * what Vectorize keeps: an id and a namespace, never the text. `puts` and `removed` record what it was handed.
 */
export const fakeSearchIndex = () => {
  const held = new Map<string, { namespace: string; words: Set<string> }>();
  const puts: Pick<SearchEntry, "id" | "kind" | "owner">[] = [];
  const removed: string[] = [];

  const index: SearchIndex = {
    put: (entries) => {
      for (const e of entries) {
        puts.push({ id: e.id, kind: e.kind, owner: e.owner });
        held.set(e.id, {
          namespace: namespaceOf(e.kind, e.owner),
          words: words(e.text),
        });
      }

      return Promise.resolve();
    },
    find: (owners, kind, text, limit) => {
      const asked = words(text);
      const namespaces = new Set(owners.map((o) => namespaceOf(kind, o)));

      const hits = [...held]
        .flatMap(([id, entry]) => {
          if (!namespaces.has(entry.namespace)) {
            return [];
          }

          const shared = [...asked].filter((w) => entry.words.has(w)).length;

          return shared
            ? [
                {
                  id,
                  score: shared / Math.sqrt(asked.size * entry.words.size),
                },
              ]
            : [];
        })
        .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit);

      return Promise.resolve(hits);
    },
    remove: (ids) => {
      for (const id of ids) {
        removed.push(id);
        held.delete(id);
      }

      return Promise.resolve();
    },
  };

  return {
    index,
    puts,
    removed,
    /** The ids it holds now. */
    ids: () => [...held.keys()].toSorted(),
    env: { ...env, SEARCH_INDEX: index },
  };
};
