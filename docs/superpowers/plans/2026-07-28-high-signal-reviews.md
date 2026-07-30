# High-Signal Reviews Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut review noise: confidence-filter findings, cap inline comments, route nits into one collapsed block, render clean approvals as one line, and rewrite the prompt with a concrete flag-bar.

**Architecture:** A pure routing function `filterAndRouteComments()` sits between `parseReviewResponse()` and posting: it normalizes confidence, applies `min-confidence` + `min-severity`, splits `suggestion`-severity findings into "minor notes", and caps inline findings at `max-comments` (overflow → minor notes). `buildReviewBody()` gains a minor-notes block and silent-on-clean rendering. `buildSystemPrompt()` gets the concrete flag-bar, comment format rule, budget line, and confidence field.

**Tech Stack:** Node.js (CommonJS), Jest, `@vercel/ncc`.

## Global Constraints

- No new npm dependencies.
- No AI mentions or Co-Authored-By in commit messages (CLAUDE.md).
- Work on branch `feature/high-signal-reviews` (branched from `main` after the Bedrock PR merges, or from `main` directly — the two changes don't overlap except `action.yml`/README/exports; rebase if needed).
- Spec file `docs/superpowers/specs/2026-07-28-high-signal-reviews-design.md` is committed on this branch (Task 1).
- Defaults: `max-comments: 5` (0 = unlimited), `min-confidence: 0.6`, missing/invalid confidence → `0.5`.
- Backward compatible: a response with no `confidence` fields must behave as before, except for the new cap/routing.
- All tests: `npx jest src/index.test.js`. Lint: `npm run lint`.

---

### Task 1: Branch + spec commit + `normalizeConfidence()` and `filterAndRouteComments()`

**Files:**
- Modify: `src/index.js` — add both functions next to `normalizeSeverity()` (~line 17); export both
- Test: `src/index.test.js` — new describe blocks
- Add: `docs/superpowers/specs/2026-07-28-high-signal-reviews-design.md` (exists on disk, untracked)

**Interfaces:**
- Consumes: `SEVERITY_LEVEL = { suggestion: 1, warning: 2, error: 3 }` (src/index.js:8), `normalizeSeverity()`.
- Produces:
  - `normalizeConfidence(value)` → number in `[0, 1]`; non-numeric/NaN/missing → `0.5`; clamps out-of-range.
  - `filterAndRouteComments(comments, { minConfidence, minSeverity, maxComments })` → `{ inline: Comment[], minorNotes: Comment[] }` where every returned comment has normalized `severity` and `confidence`. `inline` contains only `error`/`warning` findings at/above `minSeverity` and `minConfidence`, ranked severity-desc then confidence-desc, capped at `maxComments` (`0` = no cap). `minorNotes` contains surviving `suggestion` findings plus inline overflow. Findings below `minConfidence` are dropped entirely; findings below `minSeverity` are dropped entirely (existing behavior preserved).

- [ ] **Step 1: Create branch and commit the spec**

```bash
cd /Users/mayurrawte/shipthis/SherlockQA
git checkout main && git pull
git checkout -b feature/high-signal-reviews
git add docs/superpowers/specs/2026-07-28-high-signal-reviews-design.md
git commit -m "docs: add high-signal reviews design spec"
```

- [ ] **Step 2: Write the failing tests**

Add `normalizeConfidence, filterAndRouteComments` to the test file's require destructuring, then:

```js
describe('normalizeConfidence', () => {
  test('valid numbers pass through', () => {
    expect(normalizeConfidence(0.9)).toBe(0.9);
    expect(normalizeConfidence(0)).toBe(0);
    expect(normalizeConfidence(1)).toBe(1);
  });
  test('missing/invalid defaults to 0.5 (old-format responses keep working)', () => {
    expect(normalizeConfidence(undefined)).toBe(0.5);
    expect(normalizeConfidence(null)).toBe(0.5);
    expect(normalizeConfidence('high')).toBe(0.5);
    expect(normalizeConfidence(NaN)).toBe(0.5);
  });
  test('numeric strings coerce; out-of-range clamps', () => {
    expect(normalizeConfidence('0.8')).toBe(0.8);
    expect(normalizeConfidence(1.7)).toBe(1);
    expect(normalizeConfidence(-2)).toBe(0);
  });
});

describe('filterAndRouteComments (noise budget + nit routing)', () => {
  const c = (severity, confidence, file = 'a.js', line = 1) =>
    ({ file, line, severity, confidence, comment: `${severity}@${confidence}` });
  const opts = { minConfidence: 0.6, minSeverity: 'warning', maxComments: 5 };

  test('drops findings below min-confidence', () => {
    const { inline, minorNotes } = filterAndRouteComments(
      [c('error', 0.9), c('error', 0.3)], opts);
    expect(inline).toHaveLength(1);
    expect(minorNotes).toHaveLength(0);
  });

  test('missing confidence defaults to 0.5 → dropped at the 0.6 default threshold', () => {
    const { inline } = filterAndRouteComments([{ file: 'a.js', line: 1, severity: 'error', comment: 'x' }], opts);
    expect(inline).toHaveLength(0);
  });

  test('suggestion severity routes to minorNotes, never inline', () => {
    const { inline, minorNotes } = filterAndRouteComments(
      [c('suggestion', 0.9), c('warning', 0.9)],
      { ...opts, minSeverity: 'suggestion' });
    expect(inline.map(x => x.severity)).toEqual(['warning']);
    expect(minorNotes.map(x => x.severity)).toEqual(['suggestion']);
  });

  test('min-severity still drops findings entirely (suggestion below warning floor)', () => {
    const { inline, minorNotes } = filterAndRouteComments([c('suggestion', 0.9)], opts);
    expect(inline).toHaveLength(0);
    expect(minorNotes).toHaveLength(0);
  });

  test('caps inline at maxComments ranked severity desc then confidence desc; overflow → minorNotes', () => {
    const comments = [
      c('warning', 0.7), c('error', 0.65), c('warning', 0.95),
      c('error', 0.99), c('warning', 0.8)
    ];
    const { inline, minorNotes } = filterAndRouteComments(comments, { ...opts, maxComments: 3 });
    expect(inline.map(x => x.comment)).toEqual(['error@0.99', 'error@0.65', 'warning@0.95']);
    expect(minorNotes.map(x => x.comment)).toEqual(['warning@0.8', 'warning@0.7']);
  });

  test('maxComments 0 = unlimited', () => {
    const many = Array.from({ length: 12 }, (_, i) => c('error', 0.9, 'a.js', i + 1));
    const { inline } = filterAndRouteComments(many, { ...opts, maxComments: 0 });
    expect(inline).toHaveLength(12);
  });

  test('normalizes severity and confidence on the way through', () => {
    const { inline } = filterAndRouteComments(
      [{ file: 'a.js', line: 1, severity: 'ERROR', confidence: '0.9', comment: 'x' }], opts);
    expect(inline[0].severity).toBe('error');
    expect(inline[0].confidence).toBe(0.9);
  });

  test('empty/undefined input returns empty routing', () => {
    expect(filterAndRouteComments(undefined, opts)).toEqual({ inline: [], minorNotes: [] });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/index.test.js -t "filterAndRouteComments"`
Expected: FAIL — functions not exported.

- [ ] **Step 4: Implement**

Insert after `normalizeSeverity()` in `src/index.js`:

```js
// Model-supplied confidence (0-1) for a finding. Missing or unparseable values
// collapse to 0.5 so old-format responses and weaker models neither crash nor
// sail past the min-confidence filter with implicit certainty.
function normalizeConfidence(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// Noise budget: drop low-confidence and below-min-severity findings, route
// suggestion-severity findings to a consolidated "minor notes" block instead
// of inline comments, and cap inline comments at maxComments (0 = unlimited),
// ranked by severity then confidence. Overflow joins the minor notes.
function filterAndRouteComments(comments, { minConfidence, minSeverity, maxComments }) {
  const minLevel = SEVERITY_LEVEL[minSeverity] || 1;
  const surviving = (comments || [])
    .map(c => ({ ...c, severity: normalizeSeverity(c.severity), confidence: normalizeConfidence(c.confidence) }))
    .filter(c => c.confidence >= minConfidence)
    .filter(c => SEVERITY_LEVEL[c.severity] >= minLevel);

  const minorNotes = surviving.filter(c => c.severity === 'suggestion');
  const inline = surviving
    .filter(c => c.severity !== 'suggestion')
    .sort((a, b) => (SEVERITY_LEVEL[b.severity] - SEVERITY_LEVEL[a.severity]) || (b.confidence - a.confidence));

  if (maxComments > 0 && inline.length > maxComments) {
    minorNotes.push(...inline.splice(maxComments));
  }
  return { inline, minorNotes };
}
```

Export both from `module.exports`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/index.test.js`
Expected: full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "feat: confidence normalization and noise-budget comment routing"
```

---

### Task 2: Rendering — minor-notes block and silent-on-clean

**Files:**
- Modify: `src/index.js` — `buildReviewBody()` (~line 970)
- Test: `src/index.test.js`

**Interfaces:**
- Consumes: Task 1 routing output shape (`minorNotes` array of `{file, line, severity, comment}`).
- Produces: `buildReviewBody(review, prAuthor, previousCheckedScenarios, reviewStyle, useEmoji, truncated, severityCounts, responseTruncated, minorNotes = [])` — 9th positional param, default `[]` keeps every existing call site and test working.

Rendering rules (compact style):
1. **Silent-on-clean:** verdict `approved` AND zero inline issues AND zero questions AND zero minor notes → only the heading, verdict line, and one-line reason. No Summary/QA/Quality/Tests sections. (Truncation warnings still render — they change trust in the verdict.)
2. QA scenarios + questions sections render only when non-empty AND verdict ≠ `approved`.
3. Minor notes: whenever `minorNotes.length > 0`, render one collapsed block (any verdict). `detailed` style: same block appended; other sections keep current detailed behavior.

- [ ] **Step 1: Write the failing tests**

```js
describe('buildReviewBody noise reduction', () => {
  const cleanReview = {
    verdict: 'approved', verdict_reason: 'Small, safe refactor.',
    summary: 'Renames a helper.', line_comments: [],
    qa_scenarios: ['check rename works'], questions: []
  };

  test('silent-on-clean: approved with no findings renders one-liner, no QA/Summary scaffold', () => {
    const body = buildReviewBody(cleanReview, 'alice', new Set(), 'compact', true, false, null, false, []);
    expect(body).toContain('Approved');
    expect(body).toContain('Small, safe refactor.');
    expect(body).not.toContain('QA Scenarios');
    expect(body).not.toContain('**Summary:**');
  });

  test('QA scenarios render when verdict is needs_changes', () => {
    const review = { ...cleanReview, verdict: 'needs_changes', line_comments: [{ file: 'a.js', line: 1, severity: 'error', comment: 'boom' }] };
    const body = buildReviewBody(review, 'alice', new Set(), 'compact', true, false, null, false, []);
    expect(body).toContain('QA Scenarios');
  });

  test('QA scenarios suppressed on approvals even with findings-free minor notes present', () => {
    const notes = [{ file: 'a.js', line: 3, severity: 'suggestion', comment: 'could inline this' }];
    const body = buildReviewBody(cleanReview, 'alice', new Set(), 'compact', true, false, null, false, notes);
    expect(body).not.toContain('QA Scenarios');
    expect(body).toContain('Minor notes');
    expect(body).toContain('a.js:3');
    expect(body).toContain('could inline this');
  });

  test('truncation warning still renders on clean approvals', () => {
    const body = buildReviewBody(cleanReview, 'alice', new Set(), 'compact', true, true, null, false, []);
    expect(body).toMatch(/truncated/i);
  });

  test('minor notes block renders in detailed style too', () => {
    const notes = [{ file: 'b.js', line: 9, severity: 'suggestion', comment: 'nit' }];
    const body = buildReviewBody(cleanReview, 'alice', new Set(), 'detailed', true, false, null, false, notes);
    expect(body).toContain('Minor notes');
  });

  test('existing call sites without the new param are unaffected (default [])', () => {
    const body = buildReviewBody(cleanReview, 'alice', new Set(), 'compact', true, false, null, false);
    expect(body).not.toContain('Minor notes');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/index.test.js -t "noise reduction"`
Expected: FAIL (silent-on-clean and Minor notes assertions).

- [ ] **Step 3: Implement in `buildReviewBody`**

Change the signature:

```js
function buildReviewBody(review, prAuthor, previousCheckedScenarios = new Set(), reviewStyle = 'compact', useEmoji = true, truncated = false, severityCounts = null, responseTruncated = false, minorNotes = []) {
```

Inside the compact branch, replace the `isCleanApproval` handling with:

```js
    const isApproved = review.verdict === 'approved';
    const isCleanApproval = isApproved && issueCount === 0 && questionCount === 0 && minorNotes.length === 0;
    parts.push(`## ${e.detective} SherlockQA's Review\n`);
    parts.push(`**Verdict:** ${verdictEmoji[review.verdict] || e.needs_changes} ${verdictText[review.verdict] || review.verdict} | ${issueCount} issues${severityStr} · ${qaCount} QA scenarios${questionCount > 0 ? ` · ${questionCount} questions` : ''}\n`);
    if (review.verdict_reason) parts.push(`> ${review.verdict_reason}\n`);

    if (truncated) { /* keep existing warning push */ }
    if (responseTruncated) { /* keep existing warning push */ }

    if (!isCleanApproval) {
      parts.push(`**Summary:** ${review.summary || 'No summary'}\n`);
      // existing code_quality block stays here
      // existing tests_required block stays here
      if (!isApproved && review.qa_scenarios?.length > 0) { /* existing QA details block */ }
      if (!isApproved && review.questions?.length > 0) { /* existing questions line */ }
    }
```

(Concretely: wrap the existing Summary / code_quality / tests / QA / questions pushes in the `!isCleanApproval` guard, and additionally guard QA + questions with `!isApproved`. Keep the truncation warnings outside the guard. The verdict line and reason always render.)

In the detailed branch: guard QA + questions sections the same way (`review.verdict !== 'approved'`), leave the rest as-is.

At the end of BOTH branches (just before the function's existing footer/marker handling), add:

```js
  if (minorNotes.length > 0) {
    parts.push('<details>');
    parts.push(`<summary>${e.quality} <b>Minor notes (${minorNotes.length})</b> — low-severity, no action required</summary>\n`);
    minorNotes.forEach(n => {
      parts.push(`- \`${n.file}:${n.line}\` — ${n.comment}`);
    });
    parts.push('\n</details>\n');
  }
```

- [ ] **Step 4: Run the full suite; fix pre-existing tests only if their expectations conflict intentionally**

Run: `npx jest src/index.test.js`
Note: the existing test `buildReviewBody surfaces a truncation note...` uses a `needs_changes` verdict — unaffected. If any existing compact-approval test asserts the Summary renders, update it to match the new silent-on-clean contract (it is a deliberate behavior change from the spec).

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "feat: minor-notes block and silent-on-clean review rendering"
```

---

### Task 3: Prompt rewrite — flag bar, format rule, budget, confidence

**Files:**
- Modify: `src/index.js` — `buildSystemPrompt()` (signature + strictness/output sections, ~lines 700–830)
- Test: `src/index.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildSystemPrompt(persona, domainKnowledge, codeQuality, personality, strictness, mode, maxComments = 5)` — 7th positional param.

- [ ] **Step 1: Write the failing tests**

```js
describe('buildSystemPrompt high-signal rules', () => {
  test('contains the concrete flag bar instead of vibes', () => {
    const p = buildSystemPrompt('', '', false, 'professional', 'balanced', 'general', 5);
    expect(p).toMatch(/incorrect behavior, a test failure, data loss, or a security vulnerability/);
  });
  test('contains the comment format rule', () => {
    const p = buildSystemPrompt('', '', false, 'professional', 'balanced', 'general', 5);
    expect(p).toMatch(/at most 2 sentences/i);
    expect(p).toMatch(/never narrate/i);
  });
  test('budget line reflects max-comments', () => {
    const p = buildSystemPrompt('', '', false, 'professional', 'balanced', 'general', 3);
    expect(p).toMatch(/at most 3 findings/i);
    expect(p).toMatch(/empty line_comments array is a good outcome/i);
  });
  test('budget line omitted when max-comments is 0 (unlimited)', () => {
    const p = buildSystemPrompt('', '', false, 'professional', 'balanced', 'general', 0);
    expect(p).not.toMatch(/at most 0 findings/i);
  });
  test('JSON schema includes confidence', () => {
    const p = buildSystemPrompt('', '', false, 'professional', 'balanced', 'general', 5);
    expect(p).toContain('"confidence"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/index.test.js -t "high-signal rules"`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. Signature: `function buildSystemPrompt(persona, domainKnowledge, codeQuality, personality, strictness, mode, maxComments = 5) {`

2. In the JSON output format section, change the line_comments schema line to:

```
    {"file": "path/to/file.py", "line": 42, "severity": "error|warning|suggestion", "confidence": 0.9, "comment": "Problem and consequence, then the fix"}
```

3. After the strictness guidelines block (`prompt += strictnessGuidelines[...]`), append a new section:

```js
  const budgetLine = maxComments > 0
    ? `\n- Report at most ${maxComments} findings — your highest-impact ones. An empty line_comments array is a good outcome for clean code.`
    : '\n- An empty line_comments array is a good outcome for clean code.';
  prompt += `

## Signal Rules (apply to every finding):
- Flag only issues that could cause incorrect behavior, a test failure, data loss, or a security vulnerability. Style, naming, and preference nits: omit them, or mark severity "suggestion" with low confidence.
- Each comment: the problem and its consequence, then the fix, in at most 2 sentences. Never narrate what the diff does. Never praise.
- Set "confidence" to your genuine certainty the issue is real and matters (1.0 = certain bug, 0.5 = plausible, 0.3 = speculative).${budgetLine}`;
```

4. In the "Important Rules" qa_scenarios lines: change the balanced rule to `**qa_scenarios**: At most 2 scenarios covering the riskiest flows.` and lenient to `1-2 quick scenarios max.` (already is); leave strict at `3-5`.

5. Update the call site in `getAIReview()`:

```js
const systemPrompt = buildSystemPrompt(persona, domainKnowledge, codeQuality, personality, strictness, mode, maxComments);
```

and add `maxComments` to the destructured `opts` in `getAIReview` (passed from `run()` in Task 4).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/index.test.js`
Expected: PASS. Existing prompt tests (`prompt hardening`) must still pass — the new section is additive.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "feat: high-signal prompt — flag bar, format rule, budget, confidence"
```

---

### Task 4: Wire `run()` + action inputs + README + dist

**Files:**
- Modify: `src/index.js` — `run()` (~lines 91, 148–185, 232) and `getAIReview()` opts
- Modify: `action.yml` — two new inputs in the Review Configuration section
- Modify: `README.md` — inputs table + a short "Review noise controls" subsection
- Modify: `dist/index.js` (generated)

**Interfaces:**
- Consumes: `filterAndRouteComments`, updated `buildReviewBody` (9th param), updated `buildSystemPrompt` (7th param).
- Produces: end-to-end behavior; no new exports.

- [ ] **Step 1: Wire `run()`**

In the config block (~line 91):

```js
    const maxComments = parseInt(getInput('max-comments') || '5', 10);
    const minConfidence = parseFloat(getInput('min-confidence') || '0.6');
```

Pass `maxComments` into `getAIReview({ ... , maxComments })`.

Replace the post-review normalize + filter section (the `for (const c of ...) c.severity = normalizeSeverity(...)` loop and the `minLevel`-filtered `reviewComments` loop) with:

```js
    // Noise budget: confidence filter + severity floor + suggestion routing + cap.
    const routed = filterAndRouteComments(review.line_comments || [], {
      minConfidence, minSeverity, maxComments
    });
    review.line_comments = routed.inline; // downstream counts/annotations = what we post

    const linePositionMap = parseDiffForLinePositions(diff);
    const reviewComments = [];
    for (const comment of routed.inline) {
      const filePositions = linePositionMap[comment.file] || {};
      const position = filePositions[String(comment.line)];
      if (position) {
        const emoji = SEVERITY_EMOJI[comment.severity] || '🔵';
        reviewComments.push({
          path: comment.file,
          position,
          body: `${emoji} **${comment.severity.toUpperCase()}**: ${comment.comment}`
        });
      }
      // ...keep whatever the existing else-branch does (unmapped-line handling) unchanged
    }
```

Severity counts: `const severityCounts = countSeverity(routed.inline.concat(routed.minorNotes));`

Pass `routed.minorNotes` into the `buildReviewBody(...)` call as the 9th argument.

- [ ] **Step 2: action.yml inputs**

Add to the Review Configuration section:

```yaml
  max-comments:
    description: 'Maximum inline review comments per PR (noise budget). Overflow and suggestion-severity findings collapse into a "Minor notes" block. 0 = unlimited.'
    required: false
    default: '5'
  min-confidence:
    description: 'Drop findings whose model confidence (0-1) is below this. Findings without a confidence default to 0.5.'
    required: false
    default: '0.6'
```

- [ ] **Step 3: README**

Add both inputs to the inputs table, plus a short subsection near the review configuration docs:

```markdown
### Review noise controls

SherlockQA budgets its feedback so every comment is worth reading:

- `max-comments` (default 5) caps inline comments; the model is told to report only its highest-impact findings, and any overflow collapses into a "Minor notes" block.
- `min-confidence` (default 0.6) drops findings the model itself isn't sure about.
- Suggestion-severity nits never become inline comments — they land in the collapsed "Minor notes" block.
- Clean approvals render as a single verdict line, not a full report.
```

- [ ] **Step 4: Full verification**

Run: `npm run lint && npx jest && npm run build`
Expected: clean, green, dist rebuilt.

- [ ] **Step 5: Commit and open PR**

```bash
git add src/index.js action.yml README.md dist/
git commit -m "feat: wire noise-budget inputs through review pipeline"
git push -u origin feature/high-signal-reviews
gh pr create --title "feat: high-signal reviews — noise budget, confidence filter, silent-on-clean" --body "..."
```

PR body: link the spec, list the five mechanisms, call out the deliberate rendering change (silent-on-clean, QA suppressed on approvals) and the backward-compat default (`confidence` missing → 0.5). Per repo release flow, wait for user approval before merging.
