# Reliability Medium Batch (#6–#11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the six verified medium-severity reliability bugs from epic #19 (#6 review-fallback, #7 phantom diff positions, #8 silent truncation, #9 dead repo-config, #10 wrong pricing, #11 fuzzy-scenario false positives).

**Architecture:** All fixes live in the single-file action `src/index.js` (repo convention — no restructuring). Each fix is a small pure-function change or a localized change in `run()`, with a jest regression test per issue in `src/index.test.js`, one commit per issue on branch `bug/reliability-medium-batch`. `dist/` is rebuilt once at the end (the action executes `dist/index.js`).

**Tech Stack:** Node 20 GitHub Action, jest, eslint, @vercel/ncc (`npm run build`).

## Global Constraints

- Branch: `bug/reliability-medium-batch` (repo rule: never push to `main`; branch prefix `bug/`).
- Commit messages: concise, no AI mentions, no Co-Authored-By (CLAUDE.md).
- Every task: `npm test` green before commit. `npm run lint` + `npm run build` in the final task.
- Backwards compatible: default behavior with no config set must not change (one documented exception in Task 4: explicitly setting `ignore-patterns: ''` now falls back to the default ignore list).
- Test style: follow existing `src/index.test.js` — `describe('<fn> (#<issue> — <symptom>)')`, plain `test()` blocks.

---

### Task 1: estimateCost longest-prefix match (#10)

**Files:**
- Modify: `src/index.js:389-399` (`estimateCost`)
- Test: `src/index.test.js`

**Interfaces:**
- Consumes: `PRICING` table (src/index.js:370-387), already present.
- Produces: no signature change — `estimateCost(model, usage) -> number | null`.

- [ ] **Step 1: Write the failing tests** — append to `src/index.test.js` (add `estimateCost` to the require list at the top):

```js
describe('estimateCost (#10 — versioned model IDs matched the shortest prefix)', () => {
  const M = 1_000_000;

  test('versioned gpt-4.1-mini resolves to gpt-4.1-mini pricing, not gpt-4 (was 75x too high)', () => {
    expect(estimateCost('gpt-4.1-mini-2025-04-14', { input: M, output: 0 })).toBeCloseTo(0.40);
    expect(estimateCost('gpt-4.1-mini-2025-04-14', { input: 0, output: M })).toBeCloseTo(1.60);
  });

  test('versioned gpt-5-mini resolves to gpt-5-mini pricing, not gpt-5', () => {
    expect(estimateCost('gpt-5-mini-2025-08-07', { input: M, output: 0 })).toBeCloseTo(0.50);
  });

  test('exact IDs still resolve exactly', () => {
    expect(estimateCost('gpt-4', { input: M, output: 0 })).toBeCloseTo(30.00);
    expect(estimateCost('claude-sonnet-4-5', { input: M, output: M })).toBeCloseTo(18.00);
  });

  test('versioned claude ID resolves via prefix', () => {
    expect(estimateCost('claude-sonnet-4-5-20251001', { input: M, output: 0 })).toBeCloseTo(3.00);
  });

  test('unknown model or empty usage returns null', () => {
    expect(estimateCost('llama3.1', { input: M, output: M })).toBeNull();
    expect(estimateCost('gpt-4o-mini', { input: 0, output: 0 })).toBeNull();
    expect(estimateCost('gpt-4o-mini', null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest -t "estimateCost"`
Expected: FAIL — `gpt-4.1-mini-2025-04-14` input-cost is `30` (matched `gpt-4`), not `0.40`.

- [ ] **Step 3: Implement** — in `estimateCost`, replace the prefix-match line:

```js
  // Match by prefix so versioned model IDs (claude-sonnet-4-5-20251001) still
  // resolve; longest key first so gpt-4.1-mini-* can never match gpt-4 (#10).
  let entry = PRICING[model];
  if (!entry) {
    const match = Object.keys(PRICING)
      .sort((a, b) => b.length - a.length)
      .find(k => model && model.startsWith(k));
    if (match) entry = PRICING[match];
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "fix: estimateCost matches longest pricing prefix for versioned model IDs (#10)"
```

---

### Task 2: scenario carryover matching (#11)

**Files:**
- Modify: `src/index.js:1137-1151` (`isScenarioPreviouslyChecked`)
- Test: `src/index.test.js`

**Interfaces:**
- Produces: no signature change — `isScenarioPreviouslyChecked(scenario, previousCheckedScenarios: Set<string>) -> boolean`.

- [ ] **Step 1: Write the failing tests** (add `isScenarioPreviouslyChecked` to the require list):

```js
describe('isScenarioPreviouslyChecked (#11 — fuzzy match pre-checked untested scenarios)', () => {
  test('one-word action change is NOT carried over (upload vs delete)', () => {
    const prev = new Set(['Verify user can upload a file']);
    expect(isScenarioPreviouslyChecked('Verify user can delete a file', prev)).toBe(false);
  });

  test('substring containment alone is NOT a match anymore', () => {
    const prev = new Set(['Test login']);
    expect(isScenarioPreviouslyChecked('Test login with expired token and locked account', prev)).toBe(false);
  });

  test('exact scenario (modulo case/punctuation) still carries its checkmark', () => {
    const prev = new Set(['verify user can upload a file!']);
    expect(isScenarioPreviouslyChecked('Verify user can upload a file', prev)).toBe(true);
  });

  test('long scenario reworded by one word still carries its checkmark', () => {
    const prev = new Set(['Verify the user can upload a file to the shared workspace folder']);
    expect(isScenarioPreviouslyChecked('Verify the user can upload a file to the shared workspace directory', prev)).toBe(true);
  });

  test('short scenarios only match exactly (min absolute overlap)', () => {
    const prev = new Set(['Check dark mode']);
    expect(isScenarioPreviouslyChecked('Check light mode', prev)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest -t "isScenarioPreviouslyChecked"`
Expected: FAIL — upload/delete pair returns `true` (5/6 = 0.83 ≥ 0.7), substring test returns `true`.

- [ ] **Step 3: Implement** — replace the function body:

```js
function isScenarioPreviouslyChecked(scenario, previousCheckedScenarios) {
  const normalize = (text) => text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const normalizedScenario = normalize(scenario);
  for (const checked of previousCheckedScenarios) {
    const normalizedChecked = normalize(checked);
    if (normalizedScenario === normalizedChecked) return true;
    // Fuzzy carryover only for near-identical scenarios: ≥90% of the smaller
    // word set shared AND at least 4 words in common. A one-word action change
    // ("upload" → "delete") must NOT inherit the checkmark (#11), so the old
    // bare-substring rule and 0.7 threshold are gone. False negatives are the
    // safe direction — worst case QA re-tests a scenario.
    const scenarioWords = new Set(normalizedScenario.split(/\s+/).filter(Boolean));
    const checkedWords = new Set(normalizedChecked.split(/\s+/).filter(Boolean));
    const intersection = [...scenarioWords].filter(w => checkedWords.has(w));
    const minSize = Math.min(scenarioWords.size, checkedWords.size);
    if (minSize > 0 && intersection.length >= 4 && intersection.length / minSize >= 0.9) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest`
Expected: all PASS. (Sanity: upload/delete = 5/6 ≈ 0.83 < 0.9 → false; 12-word rewording = 10/11 ≈ 0.91 with 10 ≥ 4 → true.)

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "fix: tighten QA-scenario carryover so new scenarios are not pre-checked (#11)"
```

---

### Task 3: parseDiffForLinePositions rewrite (#7)

**Files:**
- Modify: `src/index.js:838-870` (`parseDiffForLinePositions`)
- Test: `src/index.test.js`

**Interfaces:**
- Produces: no signature change — `parseDiffForLinePositions(diffText) -> { [file]: { [newLine]: position } }`. Caller (`run()` at src/index.js:146-153) is untouched.

- [ ] **Step 1: Write the failing tests** (add `parseDiffForLinePositions` to the require list):

```js
describe('parseDiffForLinePositions (#7 — phantom positions leak into the previous file)', () => {
  const TWO_FILE_DIFF = [
    'diff --git a/a.js b/a.js',
    'index 1111111..2222222 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,2 +1,3 @@',
    ' line1',
    '+line2',
    ' line3',
    'diff --git a/b.js b/b.js',
    'index 3333333..4444444 100644',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1 +1,2 @@',
    ' x',
    '+y',
  ].join('\n');

  test('no positions beyond a file\'s own diff length (the phantom-position bug)', () => {
    const map = parseDiffForLinePositions(TWO_FILE_DIFF);
    expect(map['a.js']).toEqual({ 1: 1, 2: 2, 3: 3 });
    expect(map['b.js']).toEqual({ 1: 1, 2: 2 });
  });

  test('deleted files (+++ /dev/null) produce no addressable positions and do not pollute neighbors', () => {
    const diff = [
      'diff --git a/gone.js b/gone.js',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/gone.js',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-old1',
      '-old2',
      'diff --git a/kept.js b/kept.js',
      'index 5555555..6666666 100644',
      '--- a/kept.js',
      '+++ b/kept.js',
      '@@ -1 +1 @@',
      '-before',
      '+after',
    ].join('\n');
    const map = parseDiffForLinePositions(diff);
    expect(map['gone.js']).toBeUndefined();
    expect(map['kept.js']).toEqual({ 1: 2 });
  });

  test('"\\ No newline at end of file" counts toward position (final-line edits)', () => {
    const diff = [
      'diff --git a/x.js b/x.js',
      'index 1111111..2222222 100644',
      '--- a/x.js',
      '+++ b/x.js',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    // Positions: -old=1, \=2, +new=3 — GitHub counts the backslash line.
    expect(parseDiffForLinePositions(diff)['x.js']).toEqual({ 1: 3 });
  });

  test('multi-hunk files keep counting across hunk headers', () => {
    const diff = [
      'diff --git a/m.js b/m.js',
      'index 1111111..2222222 100644',
      '--- a/m.js',
      '+++ b/m.js',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '+a',
      '@@ -10,2 +10,2 @@',
      ' ctx',
      '+b',
    ].join('\n');
    // ctx=1, +a=2, second @@=3, ctx=4, +b=5
    expect(parseDiffForLinePositions(diff)['m.js']).toEqual({ 1: 1, 2: 2, 10: 4, 11: 5 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest -t "parseDiffForLinePositions"`
Expected: FAIL — `map['a.js']` contains phantom keys `4,5,6` (next file's headers); no-newline map is `{1: 2}` instead of `{1: 3}`; deleted-file hunk lines pollute `gone.js`'s previous section.

- [ ] **Step 3: Implement** — replace the function:

```js
function parseDiffForLinePositions(diffText) {
  const fileLineMap = {};
  let currentFile = null;
  let diffPosition = 0;
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of diffText.split('\n')) {
    // Every file section starts with "diff --git". Leaving the previous file
    // here guarantees its header lines (index, --- a/, +++ b/) can never be
    // recorded as the previous file's trailing positions (#7).
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    if (!currentFile) {
      // Only "+++ b/<path>" opens an addressable file. "+++ /dev/null"
      // (deleted file) has no new side, so its hunks stay unaddressable.
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
        fileLineMap[currentFile] = {};
        diffPosition = 0; // GitHub positions count per file, from its first @@
      }
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10);
      diffPosition++;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith('+')) {
      fileLineMap[currentFile][currentNewLine] = diffPosition;
      currentNewLine++;
      diffPosition++;
    } else if (line.startsWith('-')) {
      diffPosition++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" occupies a diff line — it counts toward
      // position but maps to no new-side line.
      diffPosition++;
    } else {
      fileLineMap[currentFile][currentNewLine] = diffPosition;
      currentNewLine++;
      diffPosition++;
    }
  }
  return fileLineMap;
}
```

Note: inside a hunk, `+`/`-` prefixes are checked before any header pattern, so pathological content lines like `+++ i;` are correctly treated as additions — a real next-file `+++ b/` can never appear in-hunk because `diff --git` always precedes it and resets `inHunk`.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest`
Expected: all PASS (including the pre-existing 24).

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "fix: parseDiffForLinePositions no longer leaks phantom positions across files (#7)"
```

---

### Task 4: repo-config precedence (#9)

**Files:**
- Modify: `action.yml` (remove `default:` from config-overridable inputs; state defaults in descriptions)
- Modify: `src/index.js:62-78` (extract `makeInputResolver`, add code default for `ignore-patterns`)
- Test: `src/index.test.js`

**Interfaces:**
- Produces: `makeInputResolver(repoConfig) -> (name, opts?) => string`, exported for tests; `run()` uses `const getInput = makeInputResolver(repoConfig);`.

**Why:** the node20 runner pre-fills `INPUT_*` from every `action.yml` `default:`, so `core.getInput()` is never empty for those keys and the repo-config fallback is dead code. Defaults must move into JS.

- [ ] **Step 1: Write the failing tests** (add `makeInputResolver` to the require list; `js-yaml` and `fs` are already project deps):

```js
describe('makeInputResolver (#9 — .sherlockqa.yml silently ignored)', () => {
  afterEach(() => { delete process.env['INPUT_AI-PROVIDER']; });

  test('repo config applies when the action input is unset', () => {
    const getInput = makeInputResolver({ 'ai-provider': 'anthropic' });
    expect(getInput('ai-provider')).toBe('anthropic');
  });

  test('action input wins over repo config', () => {
    process.env['INPUT_AI-PROVIDER'] = 'gemini';
    const getInput = makeInputResolver({ 'ai-provider': 'anthropic' });
    expect(getInput('ai-provider')).toBe('gemini');
  });

  test('YAML non-string values are stringified (auto-approve: true)', () => {
    const getInput = makeInputResolver({ 'auto-approve': true });
    expect(getInput('auto-approve')).toBe('true');
  });

  test('unset everywhere returns empty string', () => {
    expect(makeInputResolver({})('ai-provider')).toBe('');
  });
});

describe('action.yml (#9 — defaults must not pre-fill INPUT_* for overridable keys)', () => {
  test('config-overridable inputs carry no action.yml default', () => {
    const yaml = require('js-yaml');
    const fs = require('fs');
    const action = yaml.load(fs.readFileSync(`${__dirname}/../action.yml`, 'utf8'));
    const overridable = ['ai-provider', 'mode', 'min-severity', 'ignore-patterns',
      'max-tokens', 'auto-approve', 'code-quality', 'review-style', 'use-emoji',
      'personality', 'review-strictness', 'update-summary-comment', 'create-check-run'];
    for (const key of overridable) {
      expect(action.inputs[key].default).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest -t "#9"`
Expected: FAIL — `makeInputResolver` is not exported / not defined; action.yml defaults present.

- [ ] **Step 3: Implement.**

3a. In `src/index.js`, above `run()`, add the factory and use it (replacing the inline `const getInput = (name, opts = {}) => {...}` at lines 62-68):

```js
// Input resolution: action input > .sherlockqa.yml > '' (code defaults apply
// at the call sites). action.yml must NOT declare defaults for these keys —
// the node20 runner pre-fills INPUT_* from action.yml defaults, which would
// make core.getInput() non-empty and the repo-config fallback unreachable (#9).
function makeInputResolver(repoConfig) {
  return (name, opts = {}) => {
    const fromAction = core.getInput(name, opts);
    if (fromAction !== '' && fromAction != null) return fromAction;
    const fromConfig = repoConfig[name];
    if (fromConfig != null) return String(fromConfig);
    return '';
  };
}
```

In `run()`:

```js
    const repoConfig = loadRepoConfig();
    const getInput = makeInputResolver(repoConfig);
```

3b. Add the code-side default for `ignore-patterns` (the only helper-resolved key without one), replacing lines 74-75:

```js
    const ignorePatterns = (getInput('ignore-patterns') || '*.md,*.txt,package-lock.json,yarn.lock')
      .split(',').map(p => p.trim()).filter(Boolean);
```

3c. Add `makeInputResolver` to `module.exports`.

3d. In `action.yml`, delete the `default:` line from these inputs and append the default to each `description` instead: `ai-provider` ('openai'), `mode` ('general'), `min-severity` ('warning'), `ignore-patterns` ('*.md,*.txt,package-lock.json,yarn.lock'), `max-tokens` ('4096'), `auto-approve` ('false'), `code-quality` ('false'), `review-style` ('compact'), `use-emoji` ('true'), `personality` ('detective'), `review-strictness` ('balanced'), `update-summary-comment` ('true'), `create-check-run` ('true'). Example shape:

```yaml
  ai-provider:
    description: 'AI provider: openai, anthropic, gemini, azure, azure-responses, ollama (default: openai). Overridable via .sherlockqa.yml.'
    required: false
```

Keep `default:` on `github-token` (`${{ github.token }}` expression), `ollama-base-url`, and `azure-api-version` — those are read directly via `core.getInput` in the provider callers (not repo-config resolved) and already have identical in-code fallbacks.

**Known edge (documented, accepted):** explicitly setting `ignore-patterns: ''` in a workflow previously disabled all ignores; it now falls back to the default list (empty input is indistinguishable from unset). Workaround: a never-matching pattern.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js action.yml
git commit -m "fix: make .sherlockqa.yml config reachable — move input defaults into code (#9)"
```

---

### Task 5: response-truncation detection (#8)

**Files:**
- Modify: `src/index.js:345-367` (`getAIReview`), all six provider callers (419-613), `run()` call site (129-137, 165), `buildReviewBody` (891), `createCheckRunSafely` (1074-1096)
- Test: `src/index.test.js`

**Interfaces:**
- Produces: every `call*` returns `{ content, usage, truncated: boolean }`; `getAIReview` returns `{ review, usage, responseTruncated: boolean }` and retries once with doubled `max-tokens`; `buildReviewBody(review, prAuthor, previousCheckedScenarios, reviewStyle, useEmoji, truncated, severityCounts, responseTruncated = false)`. Exports gain `buildReviewBody`, `callAnthropic`, `callOllama`.

- [ ] **Step 1: Write the failing tests** (add `buildReviewBody`, `callAnthropic`, `callOllama` to the require list):

```js
describe('response truncation (#8 — max-tokens cutoff silently flipped verdicts)', () => {
  const origFetch = global.fetch;
  beforeEach(() => { process.env['INPUT_ANTHROPIC-API-KEY'] = 'test-key'; });
  afterEach(() => { global.fetch = origFetch; delete process.env['INPUT_ANTHROPIC-API-KEY']; });

  test('callAnthropic flags stop_reason=max_tokens as truncated', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '"summary": "cut off' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 10, output_tokens: 4096 }
      })
    });
    const r = await callAnthropic('sys', 'user', 'claude-sonnet-4-5', 4096);
    expect(r.truncated).toBe(true);
  });

  test('callAnthropic normal end_turn is not truncated', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '"verdict": "approved"}' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 50 }
      })
    });
    const r = await callAnthropic('sys', 'user', 'claude-sonnet-4-5', 4096);
    expect(r.truncated).toBe(false);
  });

  test('callOllama flags done_reason=length as truncated', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        message: { content: '{"summary": "cut' },
        done_reason: 'length',
        prompt_eval_count: 10, eval_count: 4096
      })
    });
    const r = await callOllama('sys', 'user', 'llama3.1', 4096);
    expect(r.truncated).toBe(true);
  });

  test('buildReviewBody surfaces a truncation note with a max-tokens hint', () => {
    const review = { verdict: 'needs_changes', summary: 'Unable to parse AI response', line_comments: [], qa_scenarios: [], questions: [] };
    const body = buildReviewBody(review, 'alice', new Set(), 'compact', true, false, null, true);
    expect(body).toMatch(/max-tokens/);
    expect(body).toMatch(/cut off/i);
  });

  test('buildReviewBody adds no truncation note by default', () => {
    const review = { verdict: 'approved', summary: 'ok', line_comments: [], qa_scenarios: [], questions: [] };
    const body = buildReviewBody(review, 'alice', new Set(), 'compact', true, false, null, false);
    expect(body).not.toMatch(/max-tokens/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest -t "#8"`
Expected: FAIL — `callAnthropic`/`callOllama`/`buildReviewBody` not exported; `truncated` undefined.

- [ ] **Step 3: Implement.**

3a. Add a `truncated` field to each caller's return:

```js
// callOpenAI / callAzureOpenAI:
  return {
    content: response.choices[0].message.content,
    truncated: response.choices[0].finish_reason === 'length',
    usage: { ... unchanged ... }
  };
// callAzureResponsesAPI:
  return { content, truncated: result.status === 'incomplete', usage: { ... } };
// callAnthropic:
  return { content: '{' + text, truncated: result.stop_reason === 'max_tokens', usage: { ... } };
// callGemini:
  return { content: text, truncated: result.candidates?.[0]?.finishReason === 'MAX_TOKENS', usage: { ... } };
// callOllama:
  return { content: result.message?.content || '', truncated: result.done_reason === 'length', usage: { ... } };
```

3b. In `getAIReview`, parameterize the callers by token budget, retry once on truncation, and sum usage:

```js
  const callers = {
    'azure-responses': (t) => callAzureResponsesAPI(systemPrompt, userPrompt, model, t),
    'azure': (t) => callAzureOpenAI(systemPrompt, userPrompt, model, t),
    'anthropic': (t) => callAnthropic(systemPrompt, userPrompt, model, t),
    'gemini': (t) => callGemini(systemPrompt, userPrompt, model, t),
    'ollama': (t) => callOllama(systemPrompt, userPrompt, model, t),
    'openai': (t) => callOpenAI(systemPrompt, userPrompt, model, t),
  };
  const caller = callers[provider] || callers.openai;
  const totalUsage = { input: 0, output: 0 };
  const addUsage = (u) => { totalUsage.input += u?.input || 0; totalUsage.output += u?.output || 0; };

  let result = await withRetry(() => caller(maxTokens), `provider=${provider}`);
  addUsage(result.usage);
  if (result.truncated) {
    // A cut-off JSON response used to silently parse-fail into a false
    // needs_changes verdict (#8). Retry once with double the budget.
    const bumped = maxTokens * 2;
    core.warning(`Model response hit the max-tokens limit (${maxTokens}); retrying once with ${bumped}. Consider raising max-tokens in your workflow.`);
    result = await withRetry(() => caller(bumped), `provider=${provider} retry`);
    addUsage(result.usage);
    if (result.truncated) {
      core.warning('Model response is still truncated after the retry — the review below may be incomplete.');
    }
  }
  return {
    review: parseReviewResponse(result.content),
    usage: totalUsage,
    responseTruncated: !!result.truncated
  };
```

3c. In `run()`: destructure `responseTruncated` at line 129 and pass it through:

```js
    const { review, usage, responseTruncated } = await getAIReview({ ... });
    ...
    const body = buildReviewBody(review, prAuthor, previousCheckedScenarios, reviewStyle, useEmoji, truncated, severityCounts, responseTruncated);
```

and add `responseTruncated` to the `createCheckRunSafely` opts object.

3d. In `buildReviewBody`, add the trailing parameter `responseTruncated = false` and, directly under the existing diff-`truncated` note in **both** styles (compact ~line 929, detailed ~line 967):

```js
    if (responseTruncated) {
      parts.push(`> ${e.warning} **Heads up:** the AI response hit the \`max-tokens\` limit and was cut off — findings may be missing and the verdict may be unreliable. Raise \`max-tokens\` in your workflow.\n`);
    }
```

3e. In `createCheckRunSafely`, destructure `responseTruncated` from opts and add next to the diff-truncation line:

```js
  if (responseTruncated) summaryLines.push('> ⚠️ AI response hit max-tokens — review may be incomplete.');
```

3f. Add `buildReviewBody`, `callAnthropic`, `callOllama` to `module.exports`.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "fix: detect max-tokens truncation, retry once, and surface it in the review (#8)"
```

---

### Task 6: review-submission fallback + README truth (#6)

**Files:**
- Modify: `src/index.js:179-193` (createReview catch block), add `planReviewFallback` near `planFormalReview` (~line 55)
- Modify: `README.md:264`
- Test: `src/index.test.js`

**Interfaces:**
- Produces: `planReviewFallback(plan, updateSummaryComment) -> { event: 'COMMENT', body } | null`, exported.

**Design constraint:** with the sticky summary ON (default), a failed APPROVE must NOT retry as a COMMENT review — COMMENTED reviews are undismissable and would re-create the pile-up fixed in #21/#22; the verdict is already visible in the sticky comment and Check Run. The COMMENT fallback applies when the sticky is OFF, where the review body would otherwise be lost entirely.

- [ ] **Step 1: Write the failing tests** (add `planReviewFallback` to the require list):

```js
describe('planReviewFallback (#6 — failed formal review must not lose the summary)', () => {
  test('sticky ON: no COMMENT retry (would re-create the #21 pile-up); summary lives in the sticky', () => {
    expect(planReviewFallback({ event: 'APPROVE', body: 'b' }, true)).toBeNull();
    expect(planReviewFallback({ event: 'REQUEST_CHANGES', body: 'b' }, true)).toBeNull();
  });

  test('sticky OFF: failed APPROVE degrades to a COMMENT review with the same body', () => {
    const fb = planReviewFallback({ event: 'APPROVE', body: 'full body' }, false);
    expect(fb.event).toBe('COMMENT');
    expect(fb.body).toBe('full body');
  });

  test('sticky OFF: failed REQUEST_CHANGES degrades to a COMMENT review', () => {
    expect(planReviewFallback({ event: 'REQUEST_CHANGES', body: 'b' }, false).event).toBe('COMMENT');
  });

  test('a failed COMMENT review is never retried as itself', () => {
    expect(planReviewFallback({ event: 'COMMENT', body: 'b' }, false)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest -t "planReviewFallback"`
Expected: FAIL — `planReviewFallback` is not a function.

- [ ] **Step 3: Implement.**

3a. Below `planFormalReview`, add:

```js
// After a formal review submission fails (e.g. 422 "GitHub Actions is not
// permitted to approve pull requests"), decide the degraded retry (#6). With
// the sticky summary disabled the body would otherwise be lost, so fall back
// to a plain COMMENT review. With the sticky ON, the summary is already
// posted there — a COMMENT review would just re-create the undismissable
// pile-up (#21), so no retry.
function planReviewFallback(plan, updateSummaryComment) {
  if (updateSummaryComment || plan.event === 'COMMENT') return null;
  return { event: 'COMMENT', body: plan.body };
}
```

3b. Extend the catch block in `run()`:

```js
      } catch (e) {
        core.warning(`createReview failed (event=${plan.event}): ${e.message}`);
        if (plan.event === 'APPROVE') {
          core.warning('APPROVE not permitted by this token; the verdict is still visible in the summary. See the README "Enabling Auto-Approve" section.');
        }
        const fallback = planReviewFallback(plan, updateSummaryComment);
        if (fallback) {
          try {
            await octokit.rest.pulls.createReview({
              owner, repo, pull_number: prNumber,
              commit_id: commitSha, body: fallback.body, event: fallback.event
            });
            core.info('Fell back to a COMMENT review so the summary is not lost.');
          } catch (e2) {
            core.warning(`COMMENT fallback also failed: ${e2.message}`);
          }
        }
      }
```

3c. Add `planReviewFallback` to `module.exports`.

3d. Replace README.md line 264 with:

```markdown
> By default, GitHub Actions using `GITHUB_TOKEN` cannot approve pull requests. This is a GitHub security feature. If you enable `auto-approve: true` without proper permissions, the approval is skipped with a warning — the verdict still appears in the sticky summary comment and the Check Run. If you've disabled the sticky comment (`update-summary-comment: false`), the action falls back to posting a `COMMENT` review instead of `APPROVE`, so the summary is never lost.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js README.md
git commit -m "fix: degrade failed formal reviews without losing the summary; correct README fallback claim (#6)"
```

---

### Task 7: lint, build dist, changelog, push

**Files:**
- Modify: `CHANGELOG.md` (`[Unreleased]` section), `dist/index.js` (generated)

- [ ] **Step 1: Lint and full test run**

Run: `npm run lint && npm test`
Expected: eslint clean; all suites PASS.

- [ ] **Step 2: Rebuild dist** (the action executes `dist/index.js`)

Run: `npm run build && node -e "require('./dist/index.js')" 2>&1 | head -3`
Expected: build succeeds; requiring dist does not throw module-load errors (it may warn about missing inputs — that's fine, `run()` only executes via `require.main`).

- [ ] **Step 3: Update CHANGELOG.md** — replace the `[Unreleased]` section content with:

```markdown
## [Unreleased]

### Fixed
- **Phantom inline-comment positions in multi-file diffs** ([#7](https://github.com/mayurrawte/SherlockQA/issues/7)) — the next file's diff headers were recorded as the previous file's trailing positions; deleted files and `\ No newline` markers are now handled correctly.
- **`max-tokens` truncation no longer silently flags a clean PR** ([#8](https://github.com/mayurrawte/SherlockQA/issues/8)) — providers report when output was cut off; the action retries once with a doubled budget and surfaces a clear note in the review and Check Run.
- **`.sherlockqa.yml` now actually works** ([#9](https://github.com/mayurrawte/SherlockQA/issues/9)) — `action.yml` defaults were pre-filling every input, making the repo-config fallback unreachable; defaults moved into code. Action inputs still win.
- **`cost-usd` no longer 40–75× wrong for versioned model IDs** ([#10](https://github.com/mayurrawte/SherlockQA/issues/10)) — pricing lookup now matches the longest (most specific) prefix.
- **New QA scenarios are no longer pre-checked** ([#11](https://github.com/mayurrawte/SherlockQA/issues/11)) — the carryover matcher requires near-identical scenarios instead of a loose 70% word overlap or bare substring.
- **A failed formal review no longer loses the summary** ([#6](https://github.com/mayurrawte/SherlockQA/issues/6)) — with the sticky comment disabled, a failed `APPROVE`/`REQUEST_CHANGES` degrades to a `COMMENT` review; the README now describes the real fallback behavior.

### Planned
- `@sherlock` mention-to-respond on review threads
- `/sherlock` slash commands (`review-again`, `explain`, `ignore`, `approve`)
- See [ROADMAP.md](ROADMAP.md) for full plan.
```

- [ ] **Step 4: Commit and push the branch**

```bash
git add dist/ CHANGELOG.md
git commit -m "chore: rebuild dist, changelog for reliability medium batch"
git push -u origin bug/reliability-medium-batch
```

- [ ] **Step 5: Open the PR** (do NOT merge — human review per repo rules)

```bash
gh pr create --base main --title "fix: medium-severity reliability batch (#6-#11)" --body "<summary of the six fixes, closes #6 #7 #8 #9 #10 #11>"
```

---

## Self-Review Notes

- **Spec coverage:** every acceptance criterion in #6–#11 maps to a test: #6 (fallback tests + README edit), #7 (four golden-diff tests), #8 (provider flag tests + body-note tests; retry is implementation-verified via code path), #9 (resolver precedence tests + action.yml guard test), #10 (versioned/exact/unknown tests), #11 (upload-delete, substring, rewording tests).
- **Type consistency:** `makeInputResolver` (Task 4) and `planReviewFallback` (Task 6) are new exports; `buildReviewBody` gains one trailing defaulted param (call sites without it stay valid); all `call*` return shapes gain `truncated` (additive).
- **Order dependency:** Task 5 changes `getAIReview`'s return shape consumed in `run()` — self-contained within the task. Tasks are otherwise independent; they’re sequenced smallest-first.
- **No placeholders:** all steps carry complete code.
