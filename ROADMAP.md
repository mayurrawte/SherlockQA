# SherlockQA Roadmap

> Living document. Edit freely. Move items between milestones as priorities shift.
>
> **Legend:** `[ ]` planned · `[~]` in progress · `[x]` shipped · `[?]` open question

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

## v1.2 — Conversational reviews *(next, ~1 week)*

> Make the review *interactive*, not a one-shot drop-and-leave.

- [ ] **`@sherlock` mention-to-respond** — listen on `issue_comment`, reply on the review thread
- [ ] **`/sherlock` slash commands** — `review-again`, `explain <line>`, `ignore`, `approve`
- [ ] **Sticky summary comment** — edit one pinned comment per PR instead of stacking reviews
- [ ] **GitHub Check Run output** — surface verdict + severity counts in the *Checks* column
- [ ] **Severity breakdown in verdict header** — `0 🔴 · 2 🟡 · 1 🔵`
- [ ] **Cost & token logging** — log `tokens_in / tokens_out / est_cost` for every run

**Success criteria:** users on existing v1.x workflows see no regressions; ≥3 testers confirm `@sherlock` follow-ups feel natural.

---

## v1.3 — Quality leap *(2–3 weeks)*

> Close the catch-rate gap with paid competitors using lightweight context.

- [ ] **Map-reduce chunked review** — kill the 50K-char truncation cliff
- [ ] **Light repo context** — pull file signatures of imports/symbols referenced in the diff
- [ ] **Propose-a-fix `suggestion` blocks** — one-click commit for trivial fixes
- [ ] **Learn-from-dismissals** — persist `.sherlock/dismissed.json`, skip matched findings
- [ ] **Custom rules directory** — `.sherlockqa/rules/*.md` loaded into prompt
- [ ] **PR title / conventional-commits check** — optional `check-title: true`

**Success criteria:** large PRs (>1000 lines) produce reviews without the truncation banner; dismissed findings stop reappearing.

---

## v1.4 — Distribution & polish *(parallel to v1.3)*

> Zero engineering on the core; pure leverage on installs.

- [ ] **Demo GIF in README** (top of file)
- [ ] **Workflow templates** in `.github/workflow-templates/`
- [ ] **`CHANGELOG.md`** starting at v1.1.0
- [ ] **`CONTRIBUTING.md`** + `SECURITY.md` (Marketplace SEO signal)
- [ ] **`.github/FUNDING.yml`** with GitHub Sponsors
- [ ] **Marketplace listing audit** — first 200 chars, keywords, screenshots
- [ ] **Submit PRs to** `sdras/awesome-actions`, `awesome-ai-coding`, `awesome-ai-tools`
- [ ] **Launch post**: "SherlockQA v1.2 — works with Claude, Gemini, and local models" → HN Show, dev.to, r/programming, r/devops, r/github
- [ ] **Comparison post**: "CodeRabbit vs SherlockQA vs Qodo" on dev.to / Medium
- [ ] **Jest tests** on `parseDiffForLinePositions`, `globToRegex`, `parseReviewResponse`, `isScenarioPreviouslyChecked`

**Success criteria:** 500 stars, listed on 3+ awesome lists, ≥1 article ranking page 1 for a competitor-comparison query.

---

## v1.5 — Integrations *(after v1.3 lands)*

- [ ] **Notification webhooks** — POST to Slack/Discord/Teams on `do_not_merge`
- [ ] **Linear / Jira issue creation** on critical findings
- [ ] **CODEOWNERS-aware mentions** — tag the right people for security issues
- [ ] **Re-organize source** into `src/providers/*.js` (refactor only, no behavior change)

---

## v2.0 — Repo-aware mode *(big bet)*

> The first thing that genuinely competes with CodeRabbit on catch rate.

- [ ] **Full RAG indexing** — embed the repo once, query relevant files per review
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

*Last updated: 2026-05-13*
