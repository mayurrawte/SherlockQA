# CLAUDE.md

## Overview
Node.js GitHub Action for AI-powered code review and QA; runs automated analysis on pull requests.

## Team Workflow
For any non-trivial task (new feature, refactor, bug with unclear root cause):
1. **Brainstorm first** — invoke `superpowers:brainstorming` skill before writing code. Discuss context, edge cases, dependencies.
2. **Bug fixes** — invoke `superpowers:systematic-debugging` skill before proposing any fix. Trace root cause first, never guess.
3. **Plan before code** — invoke `superpowers:writing-plans` skill to produce a step-by-step implementation plan.
4. **Parallel execution** — invoke `superpowers:dispatching-parallel-agents` for independent steps.
5. **Verify before done** — invoke `superpowers:verification-before-completion` before declaring the task complete.

**Model selection:**
- `claude-opus-4-7` — planning, brainstorming, complex bugs, architecture decisions
- `claude-sonnet-4-6` — standard feature execution, moderate bug fixes
- `claude-haiku-4-5` — simple/mechanical tasks (copy, rename, boilerplate, trivial fixes)

Simple one-liner fixes and typos are exempt from this flow.

## Response Style
Be terse. Short answers only — offer to expand rather than expand by default.

## Git Rules
- **Never add Claude as co-author or author.** No `Co-Authored-By`, no AI mentions in commits.
- **Never push to `main` or `develop`** — always create a feature branch and PR.
- **Branch names:** `feature/<name>`, `bug/<name>`, `hotfix/<name>`, `release/<name>` (lowercase, hyphens).
- **Commit messages:** concise and descriptive. No AI mentions.
