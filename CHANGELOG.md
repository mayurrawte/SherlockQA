# Changelog

All notable changes to SherlockQA are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- `@sherlock` mention-to-respond on review threads
- `/sherlock` slash commands (`review-again`, `explain`, `ignore`, `approve`)
- See [ROADMAP.md](ROADMAP.md) for full plan.

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

[Unreleased]: https://github.com/mayurrawte/SherlockQA/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/mayurrawte/SherlockQA/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mayurrawte/SherlockQA/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mayurrawte/SherlockQA/releases/tag/v1.0.0
