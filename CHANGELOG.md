# Changelog

All notable changes to SherlockQA are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- `@sherlock` mention-to-respond on review threads
- `/sherlock` slash commands (`review-again`, `explain`, `ignore`, `approve`)
- See [ROADMAP.md](ROADMAP.md) for full plan.

## [1.2.3]

### Fixed
- **Phantom inline-comment positions in multi-file diffs** ([#7](https://github.com/mayurrawte/SherlockQA/issues/7)) — the next file's diff headers were recorded as the previous file's trailing positions; deleted files and `\ No newline` markers are now handled correctly.
- **`max-tokens` truncation no longer silently flags a clean PR** ([#8](https://github.com/mayurrawte/SherlockQA/issues/8)) — providers report when output was cut off; the action retries once with a doubled budget and surfaces a clear note in the review and Check Run.
- **`.sherlockqa.yml` now actually works** ([#9](https://github.com/mayurrawte/SherlockQA/issues/9)) — `action.yml` defaults were pre-filling every input, making the repo-config fallback unreachable; defaults moved into code. Action inputs still win. (Edge: explicitly setting `ignore-patterns: ''` now falls back to the default ignore list.)
- **`cost-usd` no longer 40–75× wrong for versioned model IDs** ([#10](https://github.com/mayurrawte/SherlockQA/issues/10)) — pricing lookup now matches the longest (most specific) prefix.
- **New QA scenarios are no longer pre-checked** ([#11](https://github.com/mayurrawte/SherlockQA/issues/11)) — the carryover matcher requires near-identical scenarios instead of a loose 70% word overlap or bare substring.
- **A failed formal review no longer loses the summary** ([#6](https://github.com/mayurrawte/SherlockQA/issues/6)) — with the sticky comment disabled, a failed `APPROVE`/`REQUEST_CHANGES` degrades to a `COMMENT` review; the README now describes the real fallback behavior.

### Internal
- Jest suite grown to 52 tests; new exported helpers `makeInputResolver`, `planReviewFallback`, `buildReviewBody`, `callAnthropic`, `callOllama` for regression coverage.

## [1.2.2]

### Fixed
- **Reviews no longer pile up on every push** ([#21](https://github.com/mayurrawte/SherlockQA/issues/21)) — SherlockQA now recognizes its own prior reviews regardless of the `use-emoji` setting via a hidden `<!-- sherlockqa:review -->` marker, and the summary no longer creates an undismissable `COMMENTED` review.
- **Inline findings are synced, not stacked** — posted as individually-tagged review comments that are deleted and re-posted on each run (`syncInlineComments`).
- **Formal reviews only for dismissable terminal verdicts** (`APPROVE` / `REQUEST_CHANGES`) — the common "needs changes" outcome now surfaces via the sticky summary and Check Run instead of an un-dismissable review. With `update-summary-comment: false`, the legacy single `COMMENT` review is still posted.
- **Sticky-comment lookup is now paginated** ([#12](https://github.com/mayurrawte/SherlockQA/issues/12)) — busy PRs no longer accumulate duplicate sticky comments.

### Internal
- Jest suite grown to 24 tests, adding `planFormalReview` and `isSherlockReview` regressions.

## [1.2.1]

### Security
- **Prompt-injection hardening** ([#5](https://github.com/mayurrawte/SherlockQA/issues/5)) — the PR diff is wrapped in explicit `BEGIN/END UNTRUSTED DIFF` markers and the model is instructed to treat diff content as data, never as instructions.
- **Auto-approve disabled on `pull_request_target`** ([#5](https://github.com/mayurrawte/SherlockQA/issues/5)) — an approved verdict on a fork PR is now posted as a `COMMENT`, never an `APPROVE`, so a malicious fork diff can't steer the review into self-approving itself. Same-repo `pull_request` behavior is unchanged.

### Fixed
- **Missing or non-canonical `severity` no longer crashes the action or bypasses `min-severity`** ([#3](https://github.com/mayurrawte/SherlockQA/issues/3)) — every finding is normalized to a known tier before filtering, labeling, and counting, so the header count and severity breakdown always agree.
- **A null model response (OpenAI/Azure refusal or content filter) no longer throws an uncatchable error** ([#4](https://github.com/mayurrawte/SherlockQA/issues/4)) — it now degrades to the safe parse-fallback.

### Internal
- Pure helpers are exported behind a guarded `module.exports`; added a jest regression suite (15 tests) covering the above fixes, and cleared pre-existing lint errors. No user-facing change.

## [1.2.0]

### Added
- **Sticky summary comment** — single pinned issue-comment per PR, updated in place each run. Opt out with `update-summary-comment: false`.
- **GitHub Check Run output** — verdict + line annotations now surface in the PR's *Checks* column. Requires `checks: write` permission; gracefully no-ops with a warning if missing. Opt out with `create-check-run: false`.
- **Severity breakdown** in verdict header — `5 issues (1 🔴 · 3 🟡 · 1 🔵)`.
- **Token & cost tracking** — every provider reports input/output tokens; pricing table covers OpenAI 4o-mini/4o/4.1/5 families, Claude Sonnet/Opus/Haiku, Gemini 2.0/2.5. New outputs: `tokens-in`, `tokens-out`, `cost-usd`.

### Changed
- All provider callers now return `{ content, usage }` internally — no user-facing change.

## [1.1.0]

### Added
- **Anthropic Claude provider** (`ai-provider: anthropic`, default model `claude-sonnet-4-5`).
- **Google Gemini provider** (`ai-provider: gemini`, default model `gemini-2.0-flash`).
- **Ollama provider** for local / self-hosted models (`ai-provider: ollama`, configurable via `ollama-base-url`).
- **Security audit mode** (`mode: security`) — SAST-style review prompt focused on injections, auth flaws, secrets, crypto misuse, SSRF, XSS, and more.
- **`.sherlockqa.yml` repo config** — share defaults across workflows; action inputs take precedence.
- **Exponential-backoff retry** on 429 / 5xx for every provider.
- **Glob matcher** — `ignore-patterns` now supports `*`, `**`, and `?` (legacy substring fallback retained).
- **Diff-truncation warning** — surfaced in the posted review body when a PR is too large.
- **`pull_request_target` event support** for reviewing PRs from forks.

### Changed
- **Default OpenAI model: `gpt-4` → `gpt-4o-mini`.** Cheaper, faster, and more reliable for structured JSON output. Pin `model: gpt-4` to restore old behavior.
- OpenAI and Azure chat-completion calls now use `response_format: { type: 'json_object' }`, eliminating brittle markdown-regex JSON extraction.

### Fixed
- AI responses with stray prose around the JSON object are now best-effort recovered before falling back to the error path.

## [1.0.0]

### Added
- Initial release.
- AI-powered PR review with inline comments and summary verdict.
- OpenAI, Azure OpenAI, and Azure Responses API support.
- Five reviewer personalities: `detective`, `bro`, `desi`, `professional`, `enthusiastic`.
- Review strictness levels: `lenient`, `balanced`, `strict`.
- Optional `code-quality` analysis pass.
- QA test scenarios with preserved checkboxes across PR updates.
- Smart re-review: previous reviews dismissed on new push.
- Domain-knowledge and persona prompt injection.
- Auto-approve verdict mode.

[Unreleased]: https://github.com/mayurrawte/SherlockQA/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/mayurrawte/SherlockQA/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/mayurrawte/SherlockQA/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/mayurrawte/SherlockQA/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/mayurrawte/SherlockQA/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mayurrawte/SherlockQA/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mayurrawte/SherlockQA/releases/tag/v1.0.0
