# Contributing to SherlockQA

Thanks for thinking about contributing! SherlockQA is a small, focused GitHub Action and we try to keep it that way. This guide should get you productive in a few minutes.

## Quick start

```bash
git clone https://github.com/mayurrawte/SherlockQA.git
cd SherlockQA
npm install
```

## Project layout

```
src/index.js              # The action — single file, intentionally
action.yml                # Inputs, outputs, branding
dist/index.js             # ncc-bundled output — committed, used by GitHub
.sherlockqa.yml           # Optional repo config (consumed at runtime)
ROADMAP.md                # Versioned milestones
CHANGELOG.md              # Release notes
```

## Building

The action runs from `dist/index.js`, which is a single bundled file produced by [`@vercel/ncc`](https://github.com/vercel/ncc). **You must rebuild before committing** if you change anything in `src/`.

```bash
npm run build
```

This regenerates `dist/index.js`. Commit both `src/` and `dist/` together.

## Testing your changes locally

The action is designed to run inside GitHub Actions, so most testing happens on a draft PR. Two helpful tactics:

1. **Smoke-test the bundle loads:**
   ```bash
   node -e "require('./dist/index.js')"
   ```
   You should see `::error::Action failed: Input required and not supplied: github-token` — that proves the bundle parses and runs to the input-validation step.

2. **Real PR test:** push your branch to a fork, point a test repo's workflow at `your-fork/SherlockQA@your-branch`, and open a PR there.

## Coding conventions

- One file, on purpose. Don't fragment `src/index.js` unless we're getting a real benefit. (When we do split, it'll be `src/providers/*.js` first.)
- No comments explaining *what* the code does — let the names do that. Comments are for *why* (constraints, surprising decisions).
- No new runtime dependencies without a strong reason. The bundle ships inside `dist/index.js`; every dep inflates it.
- Match the existing style. No prettier/eslint enforcement yet, but if a PR adds churn unrelated to its purpose, expect a request to drop it.

## Adding a new AI provider

1. Add a `call<Provider>()` function that returns `{ content: string, usage: { input, output } }`.
2. Wire it into the `callers` map in `getAIReview()`.
3. Add its default model to `defaultModelFor()`.
4. Add an entry to the `PRICING` table if you have public token prices.
5. Add the API-key input to `action.yml` and document it in the README.
6. Add a usage example to the README.

## Adding a new personality

`buildSystemPrompt()` has a `personalities` map. Add a key with a system-prompt string. Personalities should:
- Have a clearly recognizable voice.
- Be supportive — funny is fine, mean is not.
- Stay in character across summary, verdict_reason, and comments.

## Reporting bugs

Open an [issue](https://github.com/mayurrawte/SherlockQA/issues) with:
- What you ran (workflow YAML snippet is gold).
- What you expected.
- What happened (include the relevant lines from the Actions log).
- Provider + model.

## Proposing a feature

Check [ROADMAP.md](ROADMAP.md) first. If it's already planned, +1 the relevant issue or PR. If it's new, open an issue describing the use case before writing code — saves both of us time.

## Pull requests

- Keep them small and focused. One concern per PR.
- Update `CHANGELOG.md` under `[Unreleased]`.
- Run `npm run build` and commit the updated `dist/`.
- Reference any relevant ROADMAP line.
- Be patient — this is a side project, not a job.

## Code of conduct

Be kind, be specific, be useful. That's it.
