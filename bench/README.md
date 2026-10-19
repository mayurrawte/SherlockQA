# Replay benchmark

Replays already-merged PRs from a local git checkout through `reviewDiff` and scores the result, so a release can be compared against an earlier baseline. Nothing is posted anywhere and `@actions/github` is never used.

## Case file

`bench/cases.local.json` is a JSON array (see `bench/cases.example.json`):

```json
{ "id": "example-bug-1", "base": "0000000", "head": "1111111", "kind": "bug", "fixCommit": "2222222" }
```

- `base`, `head`: commits of the PR as merged; the diff is `base...head`.
- `kind`: `bug` or `clean`.
- `fixCommit`: bug cases only. The later commit that fixed the bug.

Pick 20-30 cases, mixed:

- Bug: a merged PR whose bug was later fixed by a known commit. A finding counts as a hit when it is on a file the fix touched, within 5 lines of a changed line.
- Pick fix commits that land soon after the PR, so head and the fix's parent agree on that file. The finding is on head's version of the file and is matched against the old-side lines the fix replaced.
- Clean: a merged PR with no known problems. Every inline finding on it counts as noise.

`bench/cases.local.json` and `bench/results/` are gitignored. They describe private code and must never be committed.

## Run

```
SHERLOCK_BENCH_API_KEY=<key> node bench/replay.js --repo <path-to-checkout> --cases bench/cases.local.json --provider anthropic --model <model> --label <name>
```

For `bedrock`, add `--region <aws-region>` (default `us-east-1`). Use one fixed model for baseline runs. Results are written to `bench/results/<label>.json` and a summary row is printed.

Each case is replayed the way the action runs: the diff is filtered with the default ignore patterns, and the repository rule files are read from the case's `base` commit (so `base` must be reachable in `--repo`).

## Baseline

To measure v1.3.1 (commit `9abb06d`, the last commit before grouping and filtering), check it out in a separate worktree and run its bench there with the same cases and model:

```
git worktree add ../sherlockqa-baseline 9abb06d
cd ../sherlockqa-baseline && npm ci
SHERLOCK_BENCH_API_KEY=<key> node bench/replay.js --repo <path-to-checkout> --cases <path-to>/cases.local.json --provider anthropic --model <model> --label v1.3.1-baseline
```

Then run the current branch with the same `--cases` and `--model`.

## Results

A case that errors (bad sha, fix commit with no hunks, API failure) is listed under `errors` in the results file, excluded from the totals, and makes the command exit non-zero.

Numbers only, no case ids.

| label | model | date | bugs flagged / bug cases | noise comments | truncated | cost USD | wall time |
|---|---|---|---|---|---|---|---|
