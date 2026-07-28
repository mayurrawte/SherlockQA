# High-Signal Reviews (Noise Reduction)

**Date:** 2026-07-28
**Status:** Approved design, pending implementation

## Goal

Cut review noise so every posted comment is worth reading. Current pain: verbose model output, filler QA scenarios/questions on every PR, low-value findings posted as inline comments.

Patterns adopted from industry research (Greptile nitpick controls, CodeAnt overload/false-positive analyses, CodeRabbit's low-noise positioning):

1. Noise budget — cap actionable comments per PR
2. Confidence scoring — filter low-confidence findings in code, not via model self-censoring
3. Nit consolidation — low-severity findings never become inline comments
4. Silent-on-clean — clean PRs get one line, not a scaffold
5. Concrete flag-bar in the prompt, not "don't nitpick" vibes

## Inputs (action.yml)

| Input | Default | Description |
|---|---|---|
| `max-comments` | `5` | Max inline comments posted per review. `0` = unlimited. |
| `min-confidence` | `0.6` | Findings below this confidence (0–1) are dropped. |

Both overridable via `.sherlockqa.yml` like existing review config.

## Schema change

`line_comments[]` gains `"confidence": 0.0-1.0` (model's certainty the finding is real and matters). `normalizeSeverity`-style guard: missing/invalid confidence defaults to `0.5` so old-format responses and weaker models keep working. Findings that don't carry a confidence value at all **bypass the min-confidence filter** (backward compatibility — a model that never emits the field must not have every finding dropped) while still ranking at `0.5` for the severity/confidence sort. Only an explicit, out-of-range-or-parseable confidence value is subject to the `min-confidence` filter.

## Pipeline (post-parse, in order)

1. Normalize severity + confidence.
2. Drop findings with an explicit `confidence < min-confidence`. Findings without a confidence value at all bypass this filter (backward compatibility) and rank as `0.5`.
3. Apply existing `min-severity` filter.
4. Split: `error`/`warning` → inline candidates; `suggestion` → "Minor notes".
5. Cap inline candidates at `max-comments`, ranked by severity level desc, then confidence desc. Overflow moves to "Minor notes".
6. "Minor notes" render as one collapsed `<details>` block in the sticky summary (file:line + one-liner each). Never posted inline.
7. Severity counts / check-run annotations reflect what was actually posted (inline + minor notes both counted, labeled distinctly).

## Rendering changes (buildReviewBody)

- **Silent-on-clean:** verdict `approved` with zero posted findings and zero questions → render only the verdict line + one-sentence reason. No Summary/QA/Questions/Quality sections.
- QA scenarios and questions sections render only when non-empty **and** verdict ≠ `approved`. Teams that want QA scenarios on approvals keep them via existing config (`review-style: detailed` preserves current behavior for these sections).
- "Minor notes" `<details>` block appears whenever it is non-empty (any verdict).

## Prompt changes

Replace vague guidance with:

- **Flag bar:** "Flag only issues that could cause incorrect behavior, a test failure, data loss, or a security vulnerability. Style, naming, and preference nits: omit, or mark severity `suggestion` with low confidence."
- **Comment format:** "Each comment: the problem and its consequence, then the fix, in at most 2 sentences. Never narrate what the diff does. Never praise."
- **Budget awareness:** "Report at most {max-comments} findings — your highest-impact ones. An empty line_comments array is a good outcome for clean code." (When `max-comments: 0`/unlimited, this line is omitted from the prompt.)
- **Confidence:** "Set confidence to your genuine certainty the issue is real (1.0 = certain bug, 0.5 = plausible, 0.3 = speculative)."
- qa_scenarios: cap at 2 unless strictness is `strict`.

## Testing

- Confidence filter (drop below threshold; default 0.5 on missing/invalid)
- Cap + ranking (severity desc, confidence desc; overflow → minor notes)
- Suggestion-severity routing to minor notes
- Silent-on-clean rendering; sections suppressed on approvals
- Backward compat: response without confidence fields behaves as before (modulo new defaults)

## Out of scope

Per-file ignore patterns, dismissed-comment feedback loops, risk-based PR tiering, CI gating rules.
