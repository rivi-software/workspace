/**
 * Brings a deployment's copy of the repository up to date with rivi-software/workspace (README, Updates). The Update
 * workflow (.github/workflows/update.yml) runs it once a day where the repository variable AUTO_UPDATE_ENABLED is
 * "true"; `pnpm run update:upstream` runs it by hand in a clone.
 *
 *   node scripts/upstream-update.mjs [--base <upstream commit>]
 *
 * It takes the newest upstream commit whose CI passed on the upstream main (of the last 30), never a commit still
 * being checked, and merges it into the current branch: three ways, from the upstream commit the copy last took, so
 * the copy's own changes (the ids the Deploy to Cloudflare button wrote into wrangler.jsonc, `addresses`, `routes`)
 * stay. A copy the button made shares no history with upstream: its base is then the upstream commit its files are
 * closest to, the oldest of equals (a newer one would read the copy as undoing that commit). The merge commit has the
 * upstream commit as its second parent, so from then on Git knows the base itself.
 *
 * In the workflow it leaves the merged commit checked out for the checks, and writes `changed`, `workflows` (the merge
 * changes .github/workflows, which the workflow's own token may not push) and `upstream` to GITHUB_OUTPUT. On a
 * conflict it fails and names the files; run by hand it then writes them with conflict markers into the working tree
 * with the merge in progress, so resolving them, `git add` and `git commit` finish it.
 *
 * Settings, from the environment: UPSTREAM_REPOSITORY (owner/name, default rivi-software/workspace), UPSTREAM_BRANCH
 * (default main), GITHUB_TOKEN (optional, for the GitHub API's limits).
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const UPSTREAM = process.env.UPSTREAM_REPOSITORY || "rivi-software/workspace";
const BRANCH = process.env.UPSTREAM_BRANCH || "main";
const UPSTREAM_REF = `refs/remotes/upstream/${BRANCH}`;
const CI_WORKFLOW = ".github/workflows/ci.yml";

// How far back upstream to look for a commit whose CI passed, and for the commit a copy without shared history came
// from.
const CI_LOOKBACK = 30;
const BASE_LOOKBACK = 2000;

const inActions = process.env.GITHUB_ACTIONS === "true";

const git = (args, { allowFailure = false } = {}) => {
  const result = spawnSync("git", args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout.trim(),
  };
};

const short = (sha) => sha.slice(0, 12);

const output = (values) => {
  if (!process.env.GITHUB_OUTPUT) {
    return;
  }

  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join("")
  );
};

const summary = (markdown) => {
  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
};

const ciPassed = async (sha) => {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "workspace-upstream-update",
    "x-github-api-version": "2022-11-28",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${UPSTREAM}/actions/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(BRANCH)}&per_page=20`,
    { headers }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub answered ${response.status} for the CI runs of ${UPSTREAM}@${short(sha)}`
    );
  }

  const { workflow_runs: runs = [] } = await response.json();

  return runs.some(
    (run) => run.path === CI_WORKFLOW && run.conclusion === "success"
  );
};

const passingUpstreamCommit = async () => {
  const commits = git([
    "rev-list",
    "--first-parent",
    `--max-count=${CI_LOOKBACK}`,
    UPSTREAM_REF,
  ]).stdout.split("\n");

  for (const sha of commits) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- newest first, and the first that passed ends the search
    if (await ciPassed(sha)) {
      return sha;
    }
  }

  throw new Error(
    `None of the last ${CI_LOOKBACK} commits on ${UPSTREAM}@${BRANCH} has a passing CI run.`
  );
};

// The upstream commit the copy's files differ least from, by the number of paths; of equals the oldest.
const closestUpstreamCommit = (target) => {
  const commits = git([
    "rev-list",
    "--first-parent",
    `--max-count=${BASE_LOOKBACK}`,
    target,
  ]).stdout.split("\n");

  let best;

  for (const sha of commits) {
    const differs = git(["diff", "--name-only", sha, "HEAD"])
      .stdout.split("\n")
      .filter(Boolean).length;

    if (!best || differs <= best.differs) {
      best = { differs, sha };
    }
  }

  return best;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");

  if (at !== -1 && !args[at + 1]) {
    throw new Error("--base needs an upstream commit.");
  }

  return { base: at === -1 ? undefined : args[at + 1] };
};

const main = async () => {
  const options = parseArgs();

  if (git(["status", "--porcelain"]).stdout !== "") {
    throw new Error(
      "The working tree has changes; commit or set them aside first."
    );
  }

  git([
    "fetch",
    "--no-tags",
    `https://github.com/${UPSTREAM}.git`,
    `+refs/heads/${BRANCH}:${UPSTREAM_REF}`,
  ]);

  const head = git(["rev-parse", "HEAD"]).stdout;
  const target = await passingUpstreamCommit();

  if (
    git(["merge-base", "--is-ancestor", target, "HEAD"], { allowFailure: true })
      .ok
  ) {
    summary(`Up to date with ${UPSTREAM}@${short(target)}.`);
    output({ changed: "false", upstream: target, workflows: "false" });

    return;
  }

  let { base } = options;
  let guessed = false;

  if (base) {
    base = git(["rev-parse", "--verify", `${base}^{commit}`]).stdout;
  } else {
    const shared = git(["merge-base", "HEAD", target], { allowFailure: true });

    if (shared.ok) {
      base = shared.stdout;
    } else {
      const closest = closestUpstreamCommit(target);

      base = closest.sha;
      guessed = true;
      console.log(
        `This copy shares no history with ${UPSTREAM}; its files are closest to ${short(base)} (${closest.differs} paths differ), which the merge starts from.`
      );
    }
  }

  let merged;

  if (base === head) {
    // Nothing of the copy's own since the base: upstream's commit as it is.
    merged = target;
  } else {
    const result = git(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        `--merge-base=${base}`,
        "HEAD",
        target,
      ],
      { allowFailure: true }
    );

    // 0 is a clean merge, 1 a merge with conflicts; anything else is git failing.
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git merge-tree failed (git 2.40 or later is needed).`);
    }

    const [tree, ...conflicted] = result.stdout.split("\n").filter(Boolean);

    if (result.status === 1) {
      const files = [...new Set(conflicted)];

      summary(
        [
          `## The update from ${UPSTREAM}@${short(target)} conflicts`,
          "",
          `Merging from ${short(base)}${guessed ? " (the upstream commit this copy's files are closest to)" : ""}, these files changed on both sides:`,
          "",
          ...files.map((file) => `- \`${file}\``),
          "",
          `Nothing was pushed. In a clone of this repository, \`pnpm run update:upstream${guessed ? ` -- --base ${base}` : ""}\` writes them with conflict markers; resolve them, \`git add\` them, \`git commit\` and push.`,
        ].join("\n")
      );

      if (!inActions) {
        git(["read-tree", "--reset", "-u", tree]);
        const gitDir = git(["rev-parse", "--git-dir"]).stdout;
        writeFileSync(path.join(gitDir, "MERGE_HEAD"), `${target}\n`);
        writeFileSync(
          path.join(gitDir, "MERGE_MSG"),
          `chore: update from ${UPSTREAM}@${short(target)}\n`
        );
      }

      process.exitCode = 1;

      return;
    }

    merged = git([
      "commit-tree",
      tree,
      "-p",
      "HEAD",
      "-p",
      target,
      "-m",
      `chore: update from ${UPSTREAM}@${short(target)}`,
    ]).stdout;
  }

  git(["reset", "--hard", merged]);

  const workflows =
    git(["diff", "--name-only", head, merged, "--", ".github/workflows"])
      .stdout !== "";

  const commits = git([
    "log",
    "--first-parent",
    "--format=- %h %s",
    `${base}..${target}`,
  ]).stdout;

  summary(
    [
      `## Merged ${UPSTREAM}@${short(target)}`,
      "",
      `From ${short(base)}${guessed ? " (the upstream commit this copy's files were closest to)" : ""}:`,
      "",
      commits || "- (no new upstream commits)",
    ].join("\n")
  );
  output({ changed: "true", upstream: target, workflows: String(workflows) });
};

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
