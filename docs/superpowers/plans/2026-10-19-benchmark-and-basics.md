# Benchmark and Basics (Parts 0–1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record v1.3.1's review quality with a local replay benchmark, then ship v1.4.0: the code split along the review pipeline, ignored files removed from the diff, large PRs reviewed in groups instead of truncated, and the repo's own rule files read from the base branch.

**Architecture:** Extract the model-facing core of `run()` into `reviewDiff()` so the benchmark and the Action call the same code. Split `src/index.js` into pipeline modules with no behaviour change, then add the part 1 behaviour in `collect.js`, `context.js` and `review.js`. GitHub posting stays in `publish.js` and is untouched in this plan.

**Tech Stack:** Node.js ≥20, `@actions/core`, `@actions/github`, jest, `@vercel/ncc`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-19-context-and-comment-lifecycle-design.md`

## Global Constraints

- Every existing v1.x input keeps its current meaning; no input is removed or renamed.
- Code goes only to the configured model provider. The benchmark never posts to GitHub.
- Nothing beyond what `dist/` bundles; works on `ubuntu-latest` with no extra setup step.
- Rule files and repo context come from the base branch, never the PR branch. Under `pull_request_target`, never check out or parse the fork's code.
- No checkout → diff-only review plus one warning line; parts 1 behaviours that need no checkout (diff filtering, grouping) still apply.
- Release gate: versus the v1.3.1 baseline, at least as many known bugs flagged, no more noise comments, zero truncation, ≤2× cost and ≤2× wall time per PR.
- `npm test`, `npm run lint` and `npm run build` pass before every commit; `dist/` is rebuilt and committed in the same commit as any `src/` change.
- No ShipThis or other private code, PR text or file paths in committed benchmark files.

## Review Focus

- **Renames, deletions and binary files in the diff** (`rename from`, `deleted file mode`, `Binary files … differ`): filtering and splitting keep each file block whole and match on the new path. Tests in Task 3 and Task 4.
- **Every file ignored, or the diff empty after filtering:** no model call, the existing "No files to review" exit. Test in Task 3.
- **One file larger than the whole budget:** it becomes its own group, split at hunk boundaries, never cut mid-hunk. Test in Task 4.
- **A shallow checkout without the base commit, or no `.git` at all:** rules are fetched with one `git fetch --depth=1`, otherwise skipped with a warning; the review still runs. Test in Task 5.
- **Inline comment positions after filtering and grouping:** positions are still computed from GitHub's unfiltered diff, so comments land on the right lines. Test in Task 4.

---

### Task 1: Extract `reviewDiff` from `run()`

**Files:**
- Modify: `src/index.js:122-232` (`run()`), `src/index.js:1389` (`module.exports`)
- Test: `src/index.test.js`

**Interfaces:**
- Produces: `async reviewDiff({ diff, files, config }) -> { review, usage, truncated, responseTruncated }` where `config` is the object of resolved inputs `run()` already builds (`provider, model, prAuthor, persona, domainKnowledge, maxTokens, codeQuality, personality, strictness, mode, maxComments`). Behaviour identical to v1.3.1: 50,000-character truncation, one `getAIReview` call.

- [ ] **Step 1: Write the failing test** — `test('reviewDiff truncates at 50000 chars and makes one call')`: stub the provider caller (jest mock of `callAnthropic` via `provider: 'anthropic'`), pass a 60,000-char diff, assert `truncated === true`, the prompt passed to the provider contains `'[diff truncated]'`, and the mock was called once.
- [ ] **Step 2: Run** `npx jest -t "reviewDiff truncates"` — Expected: FAIL, `reviewDiff is not a function`.
- [ ] **Step 3: Implement** — move lines 193–201 of `run()` into `reviewDiff`, have `run()` call it, export it.
- [ ] **Step 4: Run** `npm test` — Expected: all 98 tests pass.
- [ ] **Step 5: Commit** — `npm run build && git add src dist && git commit -m "refactor: extract reviewDiff from run"`

### Task 2: Replay benchmark and v1.3.1 baseline (part 0)

**Files:**
- Create: `bench/replay.js`, `bench/cases.example.json`, `bench/README.md`
- Modify: `.gitignore` (add `bench/cases.local.json`, `bench/results/`)
- Test: `bench/replay.test.js`

**Interfaces:**
- Consumes: `reviewDiff` (Task 1).
- Produces: CLI `node bench/replay.js --repo <path> --cases <file> --provider <p> --model <m> --label <name>` writing `bench/results/<label>.json` and printing a summary table. Case shape: `{ "id": "string", "base": "sha", "head": "sha", "kind": "bug" | "clean", "fixCommit": "sha (bug only)" }`. Exported pure helpers: `isBugFlagged(findings, fixHunks) -> boolean` (a finding is on the file a fix commit touched, within ±5 lines of a line the fix changed), `summarise(results) -> { bugsFlagged, bugCases, noiseComments, truncatedCount, costUsd, wallMs }`.

- [ ] **Step 1: Write the failing tests** — `isBugFlagged` true for a finding at `a.py:12` when the fix changed `a.py:15`, false for `a.py:30` and for `b.py:15`; `summarise` counts noise as inline findings on `clean` cases only and sums cost and wall time.
- [ ] **Step 2: Run** `npx jest bench` — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** — diff via `git -C <repo> diff <base>...<head>`, fix hunks via `git -C <repo> show -U0 <fixCommit>`, files list from `git diff --name-only`; `config` from CLI flags with v1.3.1 defaults; never import `@actions/github`.
- [ ] **Step 4: Run** `npx jest bench` — Expected: PASS.
- [ ] **Step 5: Record the baseline** — the owner supplies 20–30 cases in `bench/cases.local.json` (mixed `bug`/`clean`); run with `--label v1.3.1-baseline` on one fixed model; paste the summary table (numbers only, no case ids) into `bench/README.md` with the model and date.
- [ ] **Step 6: Commit** — `git add bench .gitignore && git commit -m "feat: local replay benchmark with v1.3.1 baseline"`

### Task 3: Split `index.js` into pipeline modules, then filter ignored files out of the diff

**Files:**
- Create: `src/collect.js`, `src/context.js`, `src/review.js`, `src/providers/{openai,azure,anthropic,bedrock,gemini,ollama}.js`, `src/findings.js`, `src/publish.js`
- Modify: `src/index.js` (keeps `run()` and re-exports everything `index.test.js` imports)
- Test: `src/collect.test.js`

**Interfaces:**
- Produces: modules per the spec's Code structure section — `collect` (`loadRepoConfig`, `makeInputResolver`, `matchPattern`, `globToRegex`, new `filterDiff`), `review` (`reviewDiff`, `getAIReview`, `buildSystemPrompt`, `buildUserPrompt`, `withRetry`, `estimateCost`, `PRICING`, `defaultModelFor`), `providers/*` (`call*`), `findings` (`normalize*`, `filterAndRouteComments`, `parseReviewResponse`, `countSeverity`), `publish` (everything that calls octokit, `buildReviewBody`, `parseDiffForLinePositions`). New: `filterDiff(diffText, ignorePatterns) -> string` drops whole `diff --git` file blocks whose new path matches a pattern.

- [ ] **Step 1: Move code** — pure move, no edits beyond `require`/`module.exports`. Run `npm test` — Expected: 98 pass with `index.test.js` unchanged.
- [ ] **Step 2: Commit the move alone** — `npm run build && git add src dist && git commit -m "refactor: split index.js along the review pipeline"`
- [ ] **Step 3: Write the failing tests** for `filterDiff`: drops a `uv.lock` block for pattern `uv.lock`; keeps a renamed file matched on its new path only; keeps `Binary files … differ` blocks for non-ignored files intact; returns `''` when every block is ignored.
- [ ] **Step 4: Run** `npx jest collect` — Expected: FAIL.
- [ ] **Step 5: Implement `filterDiff`** and call it in `run()` before `reviewDiff`; when the result is `''`, take the existing "No files to review" exit.
- [ ] **Step 6: Run** `npm test` — Expected: PASS.
- [ ] **Step 7: Commit** — `npm run build && git add src dist && git commit -m "fix: remove ignored files from the diff sent to the model"`

### Task 4: Review large PRs in groups instead of truncating

**Files:**
- Modify: `src/collect.js`, `src/review.js`, `src/publish.js` (banner text only)
- Test: `src/review.test.js`

**Interfaces:**
- Consumes: `filterDiff` (Task 3).
- Produces: `splitDiffByFile(diffText) -> [{ file, text }]`; `groupFileDiffs(fileDiffs, budgetChars) -> [[{ file, text }]]` — same directory first, then by size, an oversized file split at `@@` hunk boundaries into its own groups; `mergeReviews(reviews) -> review` — concatenated `line_comments`, worst verdict (`do_not_merge` > `needs_changes` > `approved`), summaries joined, `qa_scenarios` capped as today. `reviewDiff` now returns `{ review, usage, truncated: false, failedFiles: string[] }`. `MAX_DIFF_CHARS` stays 50000 as the per-group budget.

- [ ] **Step 1: Write the failing tests** — a 3-file 120,000-char diff yields ≥3 groups, none over 50,000; a single 80,000-char file splits only at `@@` lines; `mergeReviews` picks `do_not_merge` over `approved` and sums usage; `reviewDiff` on that diff calls the provider once per group and never adds `'[diff truncated]'`; one group failing after retries puts its files in `failedFiles` and the others' findings are kept; `parseDiffForLinePositions` on the unfiltered diff still maps a finding in the second group to the same position as before.
- [ ] **Step 2: Run** `npx jest review` — Expected: FAIL.
- [ ] **Step 3: Implement** — groups reviewed sequentially (no parallel provider calls, keeps rate limits as today); when `failedFiles` is non-empty the summary shows one banner naming them instead of the truncation banner.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** — `npm run build && git add src dist && git commit -m "feat: review large PRs in file groups instead of truncating"`

### Task 5: Read repo rule files from the base branch

**Files:**
- Modify: `src/context.js`, `src/review.js` (`buildSystemPrompt` gains a trailing `repoRules = ''` parameter), `src/index.js` (`run()`)
- Test: `src/context.test.js`

**Interfaces:**
- Produces: `loadRuleFiles({ repoPath, baseSha, budgetChars = 20000 }) -> { rules: [{ path, text }], warning: string | null }`. Paths in order: `CLAUDE.md`, `AGENTS.md`, `PATTERNS.md`, `.cursorrules`, `.github/copilot-instructions.md`, then `.sherlockqa/rules/*.md` sorted. Read with `git -C <repoPath> show <baseSha>:<path>`; if `baseSha` is missing locally, one `git fetch --depth=1 origin <baseSha>`, then retry; still missing or no `.git` → `rules: []` and a warning. Files are added whole until the budget is reached; a file that would cross it is skipped and named in the warning.

- [ ] **Step 1: Write the failing tests** against a temp git repo created in the test: base commit has `CLAUDE.md`, PR commit edits it — loader returns the base text; `.sherlockqa/rules/b.md` and `a.md` come back as `a`, `b`; a 25,000-char `AGENTS.md` is skipped with a warning naming it; a directory with no `.git` returns `[]` and a warning; `buildSystemPrompt(..., 'RULES')` contains `RULES` after the domain-knowledge section.
- [ ] **Step 2: Run** `npx jest context` — Expected: FAIL.
- [ ] **Step 3: Implement** — `run()` calls `loadRuleFiles` with `process.env.GITHUB_WORKSPACE` and `pull_request.base.sha`, logs the warning with `core.warning`, passes the joined rules (each prefixed `### <path>`) into `buildSystemPrompt`. No checkout of PR code is added under any event.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** — `npm run build && git add src dist && git commit -m "feat: read the repo's own rule files from the base branch"`

### Task 6: Docs, benchmark gate and v1.4.0

**Files:**
- Modify: `README.md` (workflow example adds `actions/checkout@v4` before SherlockQA; rule files section), `CHANGELOG.md`, `ROADMAP.md`, `package.json` (`1.4.0`), `bench/README.md`

- [ ] **Step 1: Run the benchmark** — `node bench/replay.js … --label v1.4.0` on the same cases and model as the baseline.
- [ ] **Step 2: Check the gate** — bugs flagged ≥ baseline, noise ≤ baseline, truncated = 0, cost and wall time ≤ 2× baseline. If any fails, stop and report the table; do not release.
- [ ] **Step 3: Update docs** — results table appended to `bench/README.md`; CHANGELOG `1.4.0` lists the three behaviour changes and the module split; ROADMAP marks map-reduce review and custom rules directory shipped.
- [ ] **Step 4: Run** `npm test && npm run lint && npm run build` — Expected: all pass, `dist/` unchanged after build.
- [ ] **Step 5: Commit** — `git add -A README.md CHANGELOG.md ROADMAP.md package.json bench/README.md dist && git commit -m "release: v1.4.0"`; tagging and moving `@v1` is the owner's step.
