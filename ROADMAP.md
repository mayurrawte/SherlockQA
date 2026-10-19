# SherlockQA Roadmap

> Living document. Edit freely. Move items between milestones as priorities shift.
>
> **Legend:** `[ ]` planned · `[~]` in progress · `[x]` shipped · `[?]` open question

---

## Status

**Latest release:** [`v1.4.0`](https://github.com/mayurrawte/SherlockQA/releases/tag/v1.4.0) — shipped 2026-10-19
**Live `@v1` pointer:** `v1.4.0`
**Currently in progress:** comment lifecycle and plain-language comments (design: [`docs/superpowers/specs/2026-10-19-context-and-comment-lifecycle-design.md`](docs/superpowers/specs/2026-10-19-context-and-comment-lifecycle-design.md), part 2). The replay benchmark baseline (`bench/`) is still to be recorded.

### Recently shipped
- **v1.4.0** — large PRs reviewed in file groups instead of truncated, ignored files removed from the model's diff, repository rule files (`CLAUDE.md`, `AGENTS.md`, `PATTERNS.md`, `.sherlockqa/rules/*.md`…) and `.sherlockqa.yml` read from the base branch, local replay benchmark, source split into pipeline modules ([#36](https://github.com/mayurrawte/SherlockQA/pull/36))
- **v1.3.0 / v1.3.1** — AWS Bedrock provider, noise budget (`max-comments`), confidence filtering, high-signal prompt
- **v1.2.3** — medium-severity reliability batch: phantom diff positions, silent max-tokens truncation, dead `.sherlockqa.yml`, 40–75× cost bug, pre-checked QA scenarios, review-submission fallback ([#6](https://github.com/mayurrawte/SherlockQA/issues/6)–[#11](https://github.com/mayurrawte/SherlockQA/issues/11))
- **v1.2.2** — review pile-up fix: emoji-independent self-detection, synced inline comments, formal reviews only for terminal verdicts, paginated sticky lookup ([#21](https://github.com/mayurrawte/SherlockQA/issues/21), [#12](https://github.com/mayurrawte/SherlockQA/issues/12))
- **v1.2.1** — security & reliability: prompt-injection hardening, fork auto-approve gate, severity-crash + null-response fixes, first jest suite ([#3](https://github.com/mayurrawte/SherlockQA/issues/3), [#4](https://github.com/mayurrawte/SherlockQA/issues/4), [#5](https://github.com/mayurrawte/SherlockQA/issues/5))
- **v1.2.0** — sticky comment, GitHub Check Run, severity breakdown, token/cost tracking
- **v1.1.0** — Anthropic Claude, Google Gemini, Ollama, security mode, `.sherlockqa.yml`, retries, glob, truncation warning
- **Distribution polish** — `CHANGELOG`, `CONTRIBUTING`, `SECURITY`, `FUNDING.yml`, workflow template

### Open WIP / next-up candidates
- Record the v1.3.1 baseline and v1.4.0 run in `bench/README.md`
- Comment lifecycle + plain inline comments (v1.5, below)
- `@sherlock` mention-to-respond + `/sherlock` slash commands (the remaining v1.2 interactive items)
- Demo GIF capture (`assets/demo.gif`)
- GitHub Release notes for v1.2.0 (paste CHANGELOG section in GitHub UI)
- Marketplace listing audit + first awesome-list PR submissions

---

## Guiding principles

1. **MIT + BYO-key stays free forever.** That's the wedge against CodeRabbit/Greptile.
2. **No data leaves your CI** is a feature, not an accident. Don't break it.
3. **Backwards-compatible by default.** Every `v1.x` workflow must keep working.
4. **Ship small, ship often.** Prefer 5 small PRs over 1 mega-release.
5. **Personality is the soul.** Don't sand it off chasing enterprise vibes.

---

## Vision (12 months)

> The MIT-licensed AI code reviewer developers actually like — works with any LLM, runs anywhere, costs nothing, and reviews like a senior teammate, not a linter.

Three pillars:
- **Reach** — every major LLM provider, every CI, every team size
- **Quality** — closes the catch-rate gap with paid tools via context + memory
- **Delight** — personalities, fast feedback, zero config to start

---

## v1.1 — Multi-provider foundation ✅ *(shipped)*

- [x] Anthropic Claude provider
- [x] Google Gemini provider
- [x] Ollama (local / self-hosted) provider
- [x] `mode: security` SAST-style audit
- [x] `.sherlockqa.yml` repo config
- [x] Exponential-backoff retry on 429/5xx
- [x] OpenAI/Azure `response_format: json_object`
- [x] Glob matcher (`*`, `**`, `?`)
- [x] Diff-truncation warning in review body
- [x] `pull_request_target` event support
- [x] Default model bumped to `gpt-4o-mini`

---

## v1.3 — Reach + signal ✅ *(shipped)*

- [x] AWS Bedrock provider (Converse API, Bearer auth — any Converse-compatible model)
- [x] Noise budget: `max-comments` cap with severity/confidence ranking
- [x] Per-finding confidence + `min-confidence` filter (backward-compatible bypass)
- [x] "Minor notes" consolidation for suggestion-severity findings
- [x] Silent-on-clean approvals; QA/questions suppressed on approvals (compact style)
- [x] High-signal prompt: concrete flag bar, problem → consequence → fix format

---

## v1.2 — Conversational reviews *(partial, in progress)*

> Make the review *interactive*, not a one-shot drop-and-leave.

**v1.2.0 — Polish ✅ shipped 2026-05-14**
- [x] **Sticky summary comment** — edit one pinned issue-comment per PR
- [x] **GitHub Check Run output** — verdict + annotations surface in the *Checks* column
- [x] **Severity breakdown in verdict header** — `0 🔴 · 2 🟡 · 1 🔵`
- [x] **Cost & token logging** — `tokens-in`, `tokens-out`, `cost-usd` outputs; pricing table for OpenAI, Anthropic, Gemini

**v1.2.1 — Security & reliability ✅ shipped 2026-07-03**
- [x] **Prompt-injection hardening + fork auto-approve gate** ([#5](https://github.com/mayurrawte/SherlockQA/issues/5))
- [x] **Severity-normalization crash/bypass fix** ([#3](https://github.com/mayurrawte/SherlockQA/issues/3)) + **null-response crash fix** ([#4](https://github.com/mayurrawte/SherlockQA/issues/4))
- [x] **First jest regression suite** behind guarded `module.exports`

**v1.2.2 — Review lifecycle ✅ shipped 2026-07-08**
- [x] **Stop review pile-up** — emoji-independent self-detection, synced inline comments, formal review only for terminal verdicts ([#21](https://github.com/mayurrawte/SherlockQA/issues/21))
- [x] **Paginated sticky-comment lookup** ([#12](https://github.com/mayurrawte/SherlockQA/issues/12))

**v1.2.3 — Reliability batch ✅ shipped 2026-07-09**
- [x] **Six medium-severity fixes** — phantom diff positions ([#7](https://github.com/mayurrawte/SherlockQA/issues/7)), max-tokens truncation detection + retry ([#8](https://github.com/mayurrawte/SherlockQA/issues/8)), `.sherlockqa.yml` precedence ([#9](https://github.com/mayurrawte/SherlockQA/issues/9)), versioned-model pricing ([#10](https://github.com/mayurrawte/SherlockQA/issues/10)), QA-scenario carryover ([#11](https://github.com/mayurrawte/SherlockQA/issues/11)), review-submission fallback ([#6](https://github.com/mayurrawte/SherlockQA/issues/6))

**Interactive *(planned — versioned at release time)***
- [ ] **`@sherlock` mention-to-respond** — listen on `issue_comment`, reply on the review thread
- [ ] **`/sherlock` slash commands** — `review-again`, `explain <line>`, `ignore`, `approve`

**Success criteria:** users on existing v1.x workflows see no regressions; ≥3 testers confirm `@sherlock` follow-ups feel natural.

---

## Quality leap *(partly shipped in v1.4.0)*

> Close the catch-rate gap with paid competitors using lightweight context.

- [x] **Map-reduce chunked review** — kill the 50K-char truncation cliff *(v1.4.0: file groups, merged findings)*
- [x] **Custom rules directory** — `.sherlockqa/rules/*.md` loaded into prompt *(v1.4.0, plus `CLAUDE.md`, `AGENTS.md`, `PATTERNS.md`, `.cursorrules`, Copilot instructions — all from the base branch)*
- [x] **Ignored files out of the model's diff** *(v1.4.0)*
- [ ] **Light repo context** — superseded by the v2.0 context engine below
- [ ] **PR title / conventional-commits check** — optional `check-title: true`

**Success criteria:** large PRs (>1000 lines) produce reviews without the truncation banner ✅; beats the v1.3.1 baseline on the replay benchmark (to be recorded).

---

## v1.5 — Comment lifecycle *(next)*

> Users ignored Sherlock because comments were re-posted every run, reworded, and read like AI filler. Fix that before adding more context.

- [ ] **Stable finding IDs** — file + enclosing function + problem kind, not line number
- [ ] **Diff against the last run** — still there: untouched; fixed: "Fixed in `<sha>`" reply + resolved thread; new: posted. Never delete a thread a human replied to
- [ ] **Respect replies** — a "won't fix" reply or 👎 stops the finding being raised again on that PR
- [ ] **Review only new commits on later pushes**, carrying earlier findings forward; full re-review after a force-push
- [ ] **Plain inline comments** — personality only in the summary; problem → consequence → fix in ≤2 sentences
- [ ] **Propose-a-fix `suggestion` blocks** — one-click commit for trivial fixes
- [ ] **Slop filter** — strip praise, recaps and stock hedging before posting
- [ ] **Learn-from-dismissals** across PRs — persist dismissed finding IDs

**Success criteria:** re-pushes never produce duplicate or reworded comments; fixed findings resolve themselves; replay benchmark noise ≤ v1.4.0.

---

## v1.4 — Distribution & polish *(partial, in progress)*

> Zero engineering on the core; pure leverage on installs.

**Shipped 2026-05-14**
- [x] **Workflow template** in `.github/workflow-templates/` (auto-appears in any repo's *New workflow* picker)
- [x] **`CHANGELOG.md`** (Keep-a-Changelog) starting at v1.0
- [x] **`CONTRIBUTING.md`** + `SECURITY.md` (Marketplace SEO signal, private-vuln-report flow)
- [x] **`.github/FUNDING.yml`** with GitHub Sponsors

**Still to do**
- [ ] **Demo GIF** — record 30–45s and commit to `assets/demo.gif` (slot already wired in README)
- [ ] **Enable GitHub Sponsors** on the account (FUNDING.yml already points there)
- [ ] **Create v1.2.0 GitHub Release** — paste CHANGELOG section into the GitHub UI
- [ ] **Marketplace listing audit** — first 200 chars, keywords, screenshots
- [ ] **Submit PRs to** `sdras/awesome-actions`, `awesome-ai-coding`, `awesome-ai-tools`
- [ ] **Launch post**: "SherlockQA v1.2 — works with Claude, Gemini, and local models" → HN Show, dev.to, r/programming, r/devops, r/github
- [ ] **Comparison post**: "CodeRabbit vs SherlockQA vs Qodo" on dev.to / Medium
- [ ] **Jest tests** on `parseDiffForLinePositions`, `globToRegex`, `parseReviewResponse`, `isScenarioPreviouslyChecked`

**Success criteria:** 500 stars, listed on 3+ awesome lists, ≥1 article ranking page 1 for a competitor-comparison query.

---

## v1.6 — Integrations

- [ ] **Notification webhooks** — POST to Slack/Discord/Teams on `do_not_merge`
- [ ] **Linear / Jira issue creation** on critical findings
- [ ] **CODEOWNERS-aware mentions** — tag the right people for security issues
- [x] **Re-organize source** into `src/providers/*.js` (refactor only, no behavior change) *(v1.4.0, with `collect` / `context` / `review` / `findings` / `publish`)*

---

## v2.0 — Repo-aware mode *(big bet)*

> The first thing that genuinely competes with CodeRabbit on catch rate. Still a GitHub Action: no hosted index, code goes only to the org's own model provider.

- [ ] **Blast radius** — tree-sitter (WebAssembly, bundled) finds changed functions/classes; send their full bodies plus callers, callees and tests. Python, JS, TS first
- [ ] **Repo map** — Aider-style ranked summary of key symbols, personalised to the changed files, within a token budget
- [ ] **Files that change together** — from `git log`; flag a strongly coupled file missing from the PR
- [ ] **Verification pass** — a cheaper second call drops findings the context does not support
- [ ] **Caching** — parse results cached per git blob hash via `actions/cache`; provider prompt caching for rules and repo map
- [ ] **Full RAG indexing** — deferred: the git-hash graph above comes first; embeddings only if it falls short
- [ ] **Agent-loop fix mode** — propose a patch, run repo's own lint/test against it, then suggest
- [ ] **Multi-language deep linters** — bundle Semgrep / Trivy / TruffleHog and merge into AI review
- [ ] **Provider plugin API** — third parties can ship `@sherlockqa/provider-*` packages
- [ ] **Streaming logs** — long reviews stream progress to Actions log

**Success criteria:** catch rate within 10 points of CodeRabbit on a public PR benchmark; full v1.x compatibility preserved.

---

## v2.5+ — Optional cloud tier *(only if v2.0 sees traction)*

> "Sherlock Cloud" — managed key, dashboard, persistent memory. Pure open-core. The Action stays MIT and standalone.

- [ ] **Hosted dashboard** — analytics (issues caught, PR throughput, avg review time)
- [ ] **Persistent embeddings** — repo index lives in the cloud, faster cold starts
- [ ] **Team-shared dismissal memory** across repos
- [ ] **Pricing**: free for OSS, **$9–$12/dev/mo** for teams (undercut CodeRabbit $24)
- [ ] **Enterprise tier**: SSO/SAML, SOC2, self-hosted artifact, audit logs

**Success criteria:** profitable from month 6 on managed tier alone; OSS install base never feels nerfed.

---

## Backlog / parking lot

Ideas worth considering but not yet scheduled. Promote into a milestone when a reason appears.

- Diff-stats / language-stats footer in review
- File-level caching for unchanged files
- Pre-commit / pre-push CLI mode (`npx sherlockqa review`)
- BitBucket / GitLab / Gitea adapters (port the action to a generic CLI core)
- Voice-personality experiment (e.g., `personality: dwight` 👀)
- "Roast mode" personality for fun internal hackathons
- IDE plugin (VS Code) reusing the same prompt + provider stack
- Email digest of weekly reviews per team
- "Streak" / gamification — devs unlock a clean-PR badge

---

## How to use this roadmap

- Each unchecked item is fair game for a PR. Reference the line when you open one.
- Don't be precious about ordering. If something gets validated in production faster, pull it forward.
- Open questions go inline as `[?]` items — resolve them before starting the work.
- When a milestone ships, move it above the divider and tag the release `v1.x.0`.

---

*Last updated: 2026-10-19*
