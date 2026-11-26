import { createAI } from "agents/models/ai-sdk";
import { embedMany } from "ai";

import { aiEnabled } from "~/lib/ai";
import { assistantProvider } from "~/lib/assistant/provider.server";

/**
 * The index behind the search by meaning: texts go in as vectors and a question finds the nearest ones. In
 * the Worker the vectors are made on Workers AI (`@cf/baai/bge-m3`, multilingual, through AI Gateway with its log
 * off) and kept in Vectorize (the `SEARCH` binding, the index `workspace-search`: 1024 dimensions, cosine). A
 * vector is filed under a namespace, `mail:<owner>` or `drive:<owner>`, so a question is asked of the owner's own
 * and nothing else; the index is never what decides access, and every hit is read back through Mail's or Drive's
 * gate. It holds no text: a vector, its id (the conversation's or the file's) and its namespace.
 */

export type SearchKind = "mail" | "drive";

export interface SearchEntry {
  /** The conversation's or the file's own id. */
  id: string;
  owner: string;
  kind: SearchKind;
  text: string;
}

export interface SearchHit {
  id: string;
  /** How near it is, from 0 to 1. */
  score: number;
}

/** What indexes and finds by meaning: Workers AI and Vectorize in the Worker, an in-memory one a test lays over `env`. */
export interface SearchIndex {
  put: (entries: SearchEntry[]) => Promise<void>;
  /** The nearest entries of a kind among these owners', nearest first. */
  find: (
    owners: string[],
    kind: SearchKind,
    text: string,
    limit: number
  ) => Promise<SearchHit[]>;
  remove: (ids: string[]) => Promise<void>;
}

/** The embedding model, and the size of its vectors, which the Vectorize index must match. */
export const SEARCH_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const SEARCH_DIMENSIONS = 1024;

/** What goes into one vector, at most: the model reads about 8,000 tokens. */
export const MAX_ENTRY_CHARS = 12_000;

/** Vectorize answers at most this many matches of a query that returns no values or metadata. */
const MAX_MATCHES = 50;

/**
 * Below this a match is no match. Vectorize answers the nearest vectors whatever the question, and bge-m3's cosine
 * for an unrelated text is not small: on a real mailbox (2026-11-17) the conversations a question was about scored
 * 0.60 to 0.74, every other one 0.49 or less, and a question about nothing in the mailbox topped at 0.32.
 */
const MIN_SCORE = 0.5;

export const namespaceOf = (kind: SearchKind, owner: string) =>
  `${kind}:${owner}`;

/** The matches of one or more queries that are near enough to count, nearest first, at most `limit`. */
export const nearest = (
  matches: readonly { id: string; score: number }[],
  limit: number
): SearchHit[] =>
  matches
    .filter((m) => m.score >= MIN_SCORE)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => ({ id: m.id, score: m.score }));

const vectorizeIndex = (env: Env, vectors: VectorizeIndex): SearchIndex => {
  const model = createAI({
    binding: env.AI,
    id: env.AI_GATEWAY_ID || "workspace",
    metadata: { app: "workspace" },
    // The texts are the person's mail and files.
    collectLog: false,
  }).embedding(SEARCH_EMBEDDING_MODEL);

  const embed = async (texts: string[]) => {
    const { embeddings } = await embedMany({
      model,
      values: texts.map((t) => t.slice(0, MAX_ENTRY_CHARS)),
    });

    return embeddings;
  };

  return {
    put: async (entries) => {
      if (!entries.length) {
        return;
      }

      const values = await embed(entries.map((e) => e.text));

      await vectors.upsert(
        entries.map((e, i) => ({
          id: e.id,
          namespace: namespaceOf(e.kind, e.owner),
          values: values[i] ?? [],
        }))
      );
    },
    find: async (owners, kind, text, limit) => {
      const [vector] = await embed([text]);

      if (!vector) {
        return [];
      }

      const answers = await Promise.all(
        owners.map((owner) =>
          vectors.query(vector, {
            namespace: namespaceOf(kind, owner),
            topK: Math.min(limit, MAX_MATCHES),
            returnValues: false,
            returnMetadata: "none",
          })
        )
      );

      return nearest(
        answers.flatMap((a) => a.matches),
        limit
      );
    },
    remove: async (ids) => {
      if (ids.length) {
        await vectors.deleteByIds(ids);
      }
    },
  };
};

/**
 * The index for this Worker: a test's stand-in, else Workers AI and Vectorize when both bindings are there and the
 * Worker runs a real model, else none. Where `AI_PROVIDER` is `mock` (local dev from `.dev.vars.example`, the
 * tests, the smoke) nothing calls a model, an embedding model included, and both bindings are stand-ins that only
 * throw; there the search by meaning is off and the tools search by words. Local dev on a real provider has no
 * Vectorize either: a call fails, and the caller falls back the same way. With AI off (`AI_FEATURES`) there is none
 * at all, a test's stand-in included: the cron sends nothing to the embedding model and nothing is searched by meaning.
 */
export const searchIndexFor = (env: Env): SearchIndex | null => {
  if (!aiEnabled(env)) {
    return null;
  }

  if (env.SEARCH_INDEX) {
    return env.SEARCH_INDEX;
  }

  return assistantProvider(env) !== "mock" && env.AI && env.SEARCH
    ? vectorizeIndex(env, env.SEARCH)
    : null;
};
