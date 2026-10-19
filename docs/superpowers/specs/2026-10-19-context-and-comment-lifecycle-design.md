# Context-Aware Reviews and Comment Lifecycle

**Date:** 2026-10-19
**Status:** Draft design, pending approval

## Why

SherlockQA is the MIT, bring-your-own-key AI reviewer that runs inside the org's own CI. That stays the pitch against CodeRabbit and Greptile: code goes only to the model provider the org chose.

Today it loses to them, and to its own users' patience, in two ways:

1. **It reviews blind.** `run()` sends the raw PR diff (3 lines of context per hunk) in one model call, cut off at 50,000 characters (`src/index.js:193`). It never sees the rest of a changed file, its callers, or its tests, so it cannot catch a change that breaks another file. `ignore-patterns` only filters the file list; ignored files (lockfiles, generated code) still go into the diff and eat the 50k budget (`src/index.js:173` vs `182`). Large PRs silently lose their tail.
2. **Its comments are noise people learned to ignore.** Every run deletes all of its inline comments and posts a fresh set (`syncInlineComments`, `src/index.js:395`). The same finding comes back reworded as if new, developer replies lose their parent, and an old `REQUEST_CHANGES` review stays on the PR until a human dismisses it. The prompt tells the model to "stay in character" in every field (`src/index.js:845`), so inline comments read as AI filler.

## Goal and success

The bar for this work is **better than SherlockQA v1.3.1**, not CodeRabbit yet. Measure it by replaying 20–30 already-merged PRs through v1.3.1 and the new version on the same model:

- PRs where a bug was later fixed in the same code (a `fix:` commit touching it): did each version flag it?
- Clean PRs: how many comments were noise?
- Truncation hit or not.
- Cost and wall time per PR.

The new version must catch more, post less noise, never truncate, and stay within roughly **2× v1.3.1's cost and time per PR** (builder's default guardrail; the owner did not name a different one).

## Non-goals

- A hosted service, GitHub App, or any server SherlockQA owns. It stays a GitHub Action.
- Embeddings, vector search, RAG (still the v2.0 roadmap bet, not this).
- `@sherlock` chat and slash commands.
- A custom Merkle tree or other change-tracking structure. Git already hashes every file and folder; use it.

## Anti-goals

- Breaking any existing v1.x workflow. Every current input keeps working with today's meaning.
- Sending code anywhere except the configured model provider.
- Requiring orgs to install anything beyond what the Action bundles.
- Deleting a comment a human replied to.

## Constraints

- Node.js GitHub Action, bundled with `ncc` into `dist/`. Works on `ubuntu-latest` without extra setup steps.
- Every provider keeps working (OpenAI, Azure, Azure Responses, Anthropic, Bedrock, Gemini, Ollama).
- **Untrusted PRs.** Rule files and repo context are read from the base branch, never the PR branch, so a PR cannot rewrite its own review rules. Under `pull_request_target` (fork PRs) SherlockQA never checks out or parses the fork's code; it reviews the diff with base-branch rules and context only. (Builder's call, following the existing fork auto-approve gate.)
- The workflow must check out the repo for context features. When there is no checkout, SherlockQA falls back to diff-only review with a one-line warning, and still applies parts 1 and 2.

## Delivery: three parts, in this order

Each part ships as its own release and is useful alone.

### Part 0 — Replay benchmark

Built first, to record v1.3.1's baseline. A script replays 20–30 already-merged PRs through a given SherlockQA build on one fixed model and reports, per PR: known bugs flagged, noise comments, truncation, cost, wall time. It runs locally against a checkout, without posting to GitHub. Every later part must clear it before release: catches at least as many known bugs, no more noise, no truncation, and stays within 2× v1.3.1's cost and time. Which PRs and which model are the builder's choice; record them so runs are comparable.

### Part 1 — Basics

- **Filter the diff, not just the file list.** Drop ignored files' hunks from what the model sees.
- **No truncation cliff.** When the filtered diff exceeds the budget, split it into groups of related files (same directory first, then by size) and review each group in its own call, then merge the findings. A PR is never silently cut.
- **Read the repo's own rules.** When checked out, load the rule files a repo already keeps (`CLAUDE.md`, `AGENTS.md`, `PATTERNS.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.sherlockqa/rules/*.md`) into the prompt, within a token budget. This is how SherlockQA stays generic: no org-specific tuning in the Action, each org's rules come from its own repo.
- **Docs:** README workflow example adds `actions/checkout` before SherlockQA.

### Part 2 — Comment lifecycle and language

- **Stable finding IDs.** Each finding gets a fingerprint from file path + enclosing function/class name + problem category, not the line number, so it survives code moving. Hidden in the comment body alongside the existing marker.
- **Diff against the previous run instead of delete-and-repost:**
  - still present → leave the existing comment untouched
  - no longer present → reply "Fixed in `<short sha>`" and resolve the thread (GraphQL `resolveReviewThread`)
  - new → post it
- **Respect replies.** If a human replied to a finding's thread or reacted 👎, do not re-raise that finding on this PR.
- **Stale verdicts.** `findPreviousState` already dismisses its earlier APPROVED/CHANGES_REQUESTED reviews every run, but logs a failed dismissal only at info level. Keep the behaviour; raise a failed dismissal to a warning that names the likely cause (token permissions or branch protection). (Builder's call: users reported verdicts not being dismissed, so the fix is making failures visible, not new behaviour.)
- **Review only what's new on later pushes.** On `synchronize`, review commits since the last reviewed SHA (stored in the sticky comment's hidden state). Earlier findings are carried forward by fingerprint matching only, with no extra model call: a finding whose code was touched by the new commits is re-judged as part of the new review; an untouched one stays open as is. If the last reviewed SHA is gone (force-push, rebase), re-review the whole PR. (Builder's call.)
- **Where the enclosing symbol comes from.** In part 2 the model reports the enclosing function/class name for each finding. In part 3 tree-sitter supplies the same name in the same format, so fingerprints do not change between releases and open findings never flip to "fixed" then "new". (Builder's call.)
- **Plain language in inline comments.** Inline comments are always plain: problem, what breaks, the fix, at most two sentences. Personality voice applies only to the sticky summary. (Builder's call to reconcile the roadmap's "personality is the soul" with users ignoring slop.)
- **Suggestion blocks.** When the fix is a small, self-contained edit, post it as a GitHub ```` ```suggestion ```` block so it is one click to apply.
- **Slop filter.** Before posting, strip or reject comments containing praise, PR recaps, and stock hedging phrases from a short maintained list.

### Part 3 — Context engine

- **Blast radius.** Parse changed files with tree-sitter (WebAssembly build, grammars bundled; Python, JavaScript, TypeScript first). For each changed function/class, include its full body plus callers, the code it calls, and tests that reference it.
- **Repo map.** An Aider-style ranked summary of the rest of the repo (key symbols and signatures, ranked by how often other code references them, personalised toward the changed files), trimmed to a token budget.
- **Files that change together.** From `git log`, find files that historically change with the touched files. If a strongly coupled file is missing from the PR, give the model that fact so it can ask "did you forget X?". Cheap and language-agnostic.
- **Verification pass.** A second, cheaper call checks each finding against the gathered context and drops ones it does not support.
- **Caching.** Cache each file's parse result keyed by its git blob hash via `actions/cache`; re-parse only files whose hash is new. Use provider prompt caching (Anthropic, Bedrock) for the rules and repo map, which repeat across calls.
- **Context fills a budget, never overflows it.** Priority order: diff → changed function bodies → callers/tests → co-change hints → repo map. Lower tiers are trimmed first.

## Left to the builder

- Exact token budgets per tier, grouping heuristics for large PRs, and the fingerprint's category taxonomy.
- New input names and defaults, provided defaults keep v1.x behaviour safe.
- Whether part 3's languages beyond Python/JS/TS ship in the same release.
## Code structure

The owner is open to rethinking SherlockQA's structure. `src/index.js` is one 1,400-line file; parts 2 and 3 would make it unworkable. Part 1 starts by splitting it along the review pipeline, with no behaviour change in that step (builder's call on the exact layout):

- `collect` — PR metadata, filtered diff, previous run state
- `context` — rule files, then (part 3) blast radius, repo map, co-change, cache
- `review` — prompt building and the `providers/` (one file per provider, as roadmap v1.5 planned)
- `findings` — parsing, confidence/severity filtering, fingerprints, slop filter, verification
- `publish` — inline comment lifecycle, sticky summary, formal review, check run

The jest suite moves with the code and must pass unchanged before part 1's behaviour changes land.
