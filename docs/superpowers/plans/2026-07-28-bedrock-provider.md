# AWS Bedrock Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `bedrock` as an `ai-provider` option calling the AWS Bedrock Converse API with Bearer-token auth over plain fetch.

**Architecture:** One new fetch-based `callBedrock()` function in `src/index.js` following the exact pattern of `callAnthropic()`, registered in the `callers` dispatch map in `getAIReview()`. Cost estimation normalizes `anthropic.`-prefixed Bedrock model IDs to reuse existing Claude pricing rows.

**Tech Stack:** Node.js (CommonJS), native `fetch`, Jest (mocked `global.fetch`), `@vercel/ncc` for dist build.

## Global Constraints

- No new npm dependencies (spec: zero-SDK fetch pattern).
- No AI mentions or Co-Authored-By in commit messages (CLAUDE.md).
- Work on branch `feature/bedrock-provider` — never commit to `main`.
- Spec file `docs/superpowers/specs/2026-07-28-bedrock-provider-design.md` is committed on this branch (Task 1).
- All tests: `npx jest src/index.test.js` from repo root. Lint: `npm run lint`.
- Default Bedrock model: `anthropic.claude-sonnet-5`. Default region: `us-east-1`.

---

### Task 1: Branch + spec commit + `callBedrock()`

**Files:**
- Modify: `src/index.js` (add `callBedrock` after `callAnthropic` ~line 600; add to `module.exports` ~line 1268)
- Test: `src/index.test.js` (new describe block after the `response truncation` block ~line 397)
- Add: `docs/superpowers/specs/2026-07-28-bedrock-provider-design.md` (already exists on disk, untracked)

**Interfaces:**
- Consumes: `core.getInput(name, opts)` from `@actions/core` (already imported as `core`).
- Produces: `async callBedrock(systemPrompt, userPrompt, model, maxTokens)` → `{ content: string, truncated: boolean, usage: { input: number, output: number } }`. Throws `Error` with `.status` on non-2xx.

- [ ] **Step 1: Create branch and commit the spec**

```bash
cd /Users/mayurrawte/shipthis/SherlockQA
git checkout -b feature/bedrock-provider
git add docs/superpowers/specs/2026-07-28-bedrock-provider-design.md
git commit -m "docs: add Bedrock provider design spec"
```

- [ ] **Step 2: Write the failing tests**

Add to `src/index.test.js`. First extend the require at the top of the file (~line 16, where `callOllama` is imported) to also destructure `callBedrock`:

```js
const {
  // ...existing names...
  callAnthropic,
  callOllama,
  callBedrock,
} = require('./index');
```

Then add the describe block:

```js
describe('callBedrock (Converse API, Bearer auth)', () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    process.env['INPUT_BEDROCK-API-KEY'] = 'test-bedrock-key';
    process.env['INPUT_AWS-REGION'] = 'eu-west-1';
  });
  afterEach(() => {
    global.fetch = origFetch;
    delete process.env['INPUT_BEDROCK-API-KEY'];
    delete process.env['INPUT_AWS-REGION'];
  });

  const okResponse = (overrides = {}) => ({
    ok: true,
    json: async () => ({
      output: { message: { role: 'assistant', content: [{ text: '{"verdict": "approved"}' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      ...overrides
    })
  });

  test('sends Converse request: region + URL-encoded model in URL, Bearer header, system/messages/inferenceConfig body', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await callBedrock('sys prompt', 'user prompt', 'anthropic.claude-sonnet-5', 4096);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-sonnet-5/converse');
    expect(opts.headers['Authorization']).toBe('Bearer test-bedrock-key');
    const body = JSON.parse(opts.body);
    expect(body.system).toEqual([{ text: 'sys prompt' }]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ text: 'user prompt' }] }]);
    expect(body.inferenceConfig).toEqual({ maxTokens: 4096 });
  });

  test('URL-encodes model IDs containing colons (inference profiles like us.anthropic....:0)', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    await callBedrock('s', 'u', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 1024);
    const [url] = global.fetch.mock.calls[0];
    expect(url).toContain('/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse');
  });

  test('extracts text and usage from Converse response', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse());
    const r = await callBedrock('s', 'u', 'anthropic.claude-sonnet-5', 4096);
    expect(r.content).toBe('{"verdict": "approved"}');
    expect(r.usage).toEqual({ input: 100, output: 50 });
    expect(r.truncated).toBe(false);
  });

  test('flags stopReason=max_tokens as truncated', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse({ stopReason: 'max_tokens' }));
    const r = await callBedrock('s', 'u', 'anthropic.claude-sonnet-5', 64);
    expect(r.truncated).toBe(true);
  });

  test('joins multiple text content blocks and ignores non-text blocks', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse({
      output: { message: { role: 'assistant', content: [{ text: '{"a":' }, { toolUse: { name: 'x' } }, { text: '1}' }] } }
    }));
    const r = await callBedrock('s', 'u', 'anthropic.claude-sonnet-5', 4096);
    expect(r.content).toBe('{"a":1}');
  });

  test('non-2xx throws with status attached (so withRetry can decide)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429, text: async () => 'ThrottlingException'
    });
    await expect(callBedrock('s', 'u', 'anthropic.claude-sonnet-5', 4096))
      .rejects.toThrow(/Bedrock API: 429/);
    await callBedrock('s', 'u', 'anthropic.claude-sonnet-5', 4096).catch(e => {
      expect(e.status).toBe(429);
    });
  });

  test('missing usage fields default to 0', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse({ usage: undefined }));
    const r = await callBedrock('s', 'u', 'anthropic.claude-sonnet-5', 4096);
    expect(r.usage).toEqual({ input: 0, output: 0 });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/index.test.js -t "callBedrock"`
Expected: FAIL — `callBedrock` is not a function (not exported yet).

- [ ] **Step 4: Implement `callBedrock`**

Insert in `src/index.js` directly after the `callAnthropic` function ends (~line 600):

```js
async function callBedrock(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('bedrock-api-key', { required: true });
  const region = core.getInput('aws-region') || 'us-east-1';
  // Converse API is model-agnostic (Claude, Llama, Mistral, Nova...). Bearer
  // auth uses a Bedrock API key — SigV4/IAM-role auth is intentionally not
  // supported to keep the zero-SDK fetch pattern.
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: userPrompt }] }],
      inferenceConfig: { maxTokens }
    })
  });
  if (!response.ok) {
    const err = new Error(`Bedrock API: ${response.status} - ${await response.text()}`);
    err.status = response.status;
    throw err;
  }
  const result = await response.json();
  const blocks = result.output?.message?.content || [];
  const text = blocks.filter(b => typeof b.text === 'string').map(b => b.text).join('');
  return {
    content: text,
    truncated: result.stopReason === 'max_tokens',
    usage: {
      input: result.usage?.inputTokens || 0,
      output: result.usage?.outputTokens || 0
    }
  };
}
```

Add `callBedrock,` to `module.exports` (after `callOllama,`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/index.test.js -t "callBedrock"`
Expected: all 7 PASS. Then run the full suite: `npx jest src/index.test.js` — everything green.

- [ ] **Step 6: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "feat: add callBedrock via Converse API with Bearer auth"
```

---

### Task 2: Wire provider dispatch, default model, and action inputs

**Files:**
- Modify: `src/index.js` — `callers` map in `getAIReview()` (~line 383) and `defaultModelFor()` (~line 271)
- Modify: `action.yml` — new inputs after the Azure block (~line 57), plus `ai-provider` + top `description` text
- Test: `src/index.test.js`

**Interfaces:**
- Consumes: `callBedrock` from Task 1.
- Produces: `defaultModelFor('bedrock')` → `'anthropic.claude-sonnet-5'`; provider key `'bedrock'` dispatches to `callBedrock`.

- [ ] **Step 1: Write the failing test**

`defaultModelFor` is not currently exported. Add it to the test's require list and to `module.exports` (implementation step below). Test:

```js
describe('bedrock provider wiring', () => {
  test('defaultModelFor(bedrock) is the prefixed Bedrock Claude id', () => {
    expect(defaultModelFor('bedrock')).toBe('anthropic.claude-sonnet-5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/index.test.js -t "bedrock provider wiring"`
Expected: FAIL — `defaultModelFor` is not a function.

- [ ] **Step 3: Implement wiring**

In `defaultModelFor()` add a case:

```js
    case 'bedrock': return 'anthropic.claude-sonnet-5';
```

In `getAIReview()`'s `callers` map add (alphabetical position, after `'azure'`):

```js
    'bedrock': (t) => callBedrock(systemPrompt, userPrompt, model, t),
```

Export `defaultModelFor` from `module.exports`.

In `action.yml`:
1. Top-level `description`: append `, and AWS Bedrock` → `'...Works with OpenAI, Anthropic Claude, Google Gemini, Azure OpenAI, Ollama, and AWS Bedrock.'`
2. `ai-provider` description → `'AI provider: openai, anthropic, gemini, azure, azure-responses, ollama, bedrock (default: openai). Overridable via .sherlockqa.yml.'`
3. `model` description: append `, bedrock=anthropic.claude-sonnet-5`.
4. New block after the Azure inputs:

```yaml
  # AWS Bedrock Configuration
  bedrock-api-key:
    description: 'AWS Bedrock API key — Bearer token (required if ai-provider=bedrock). IAM-role/SigV4 auth is not supported.'
    required: false
  aws-region:
    description: 'AWS region for the Bedrock runtime endpoint'
    required: false
    default: 'us-east-1'
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/index.test.js`
Expected: PASS (including the new wiring test).

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js action.yml
git commit -m "feat: wire bedrock provider dispatch, default model, action inputs"
```

---

### Task 3: Cost estimation for prefixed Bedrock model IDs

**Files:**
- Modify: `src/index.js` — `PRICING` table (~line 424) and `estimateCost()` (~line 435)
- Test: `src/index.test.js` — extend the existing `estimateCost` describe block (~line 164)

**Interfaces:**
- Consumes: existing `estimateCost(model, usage)` export.
- Produces: same signature; now strips `anthropic.` / `us.anthropic.` / `eu.anthropic.` prefixes before lookup.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('estimateCost ...')` block:

```js
  test('bedrock anthropic.-prefixed id resolves to the claude pricing row', () => {
    expect(estimateCost('anthropic.claude-sonnet-5', usage))
      .toBeCloseTo((1000 * 3.00 + 1000 * 15.00) / 1e6);
  });

  test('bedrock us. inference-profile id resolves via prefix strip + version prefix match', () => {
    expect(estimateCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', usage))
      .toBeCloseTo((1000 * 1.00 + 1000 * 5.00) / 1e6);
  });

  test('non-claude bedrock model returns null (no pricing row)', () => {
    expect(estimateCost('meta.llama3-1-70b-instruct-v1:0', usage)).toBeNull();
  });
```

(The block already defines `const usage = { input: 1000, output: 1000 };` — reuse it; if it defines different numbers, match the existing constant.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/index.test.js -t "estimateCost"`
Expected: the two new claude tests FAIL (return null today); the llama test passes trivially.

- [ ] **Step 3: Implement**

Add pricing rows to `PRICING` (after `'claude-haiku-4-5'`) — Anthropic list prices; Bedrock pricing is AWS-set so this stays an estimate:

```js
  'claude-sonnet-5':     { in: 3.00,  out: 15.00 },
  'claude-opus-5':       { in: 5.00,  out: 25.00 },
```

In `estimateCost()`, normalize before lookup — replace the line `let entry = PRICING[model];` and the prefix-match block's uses of `model` with a normalized id:

```js
function estimateCost(model, usage) {
  if (!usage || (!usage.input && !usage.output)) return null;
  // Bedrock Claude IDs carry a provider prefix (anthropic., us.anthropic.,
  // eu.anthropic.) — strip it so the claude-* pricing rows match. AWS-set
  // Bedrock prices can differ from Anthropic list prices; this is an estimate.
  const normalized = (model || '').replace(/^(us\.|eu\.)?anthropic\./, '');
  // Match by prefix so versioned model IDs (claude-sonnet-4-5-20251001) still
  // resolve; longest key first so gpt-4.1-mini-* can never match gpt-4 (#10).
  let entry = PRICING[normalized];
  if (!entry) {
    const match = Object.keys(PRICING)
      .sort((a, b) => b.length - a.length)
      .find(k => normalized && normalized.startsWith(k));
    if (match) entry = PRICING[match];
  }
  if (!entry) return null;
  return (usage.input * entry.in + usage.output * entry.out) / 1_000_000;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/index.test.js`
Expected: full suite PASS, including the pre-existing `#10` prefix tests (regression guard).

- [ ] **Step 5: Commit**

```bash
git add src/index.js src/index.test.js
git commit -m "feat: price bedrock claude ids via prefix normalization; add sonnet-5/opus-5 rows"
```

---

### Task 4: README docs, lint, dist build, PR

**Files:**
- Modify: `README.md` (provider list/table + new Bedrock section near the other provider setup sections)
- Modify: `dist/index.js` (generated — `npm run build`)

**Interfaces:**
- Consumes: everything above.
- Produces: shippable branch.

- [ ] **Step 1: Add README section**

Locate the provider setup sections in README.md (search for "Ollama" or "Azure OpenAI") and add, following the same heading style:

```markdown
### AWS Bedrock

Uses the model-agnostic [Converse API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html), so any Bedrock chat model works (Claude, Llama, Mistral, Nova...). Authenticate with a [Bedrock API key](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html) (Bearer token) — IAM-role/OIDC/SigV4 auth is not supported.

​```yaml
- uses: mayurrawte/SherlockQA@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    ai-provider: bedrock
    bedrock-api-key: ${{ secrets.BEDROCK_API_KEY }}
    aws-region: us-east-1          # default
    model: anthropic.claude-sonnet-5   # default; any Converse-compatible model id works
​```
```

(Remove the zero-width escapes around the fences when writing — they mark the nested code block here only.)

Also update any provider enumeration lines in README (intro, inputs table) to include `bedrock`, `bedrock-api-key`, `aws-region`.

- [ ] **Step 2: Lint, test, build**

Run: `npm run lint && npx jest && npm run build`
Expected: lint clean, tests green, `dist/index.js` regenerated.

- [ ] **Step 3: Commit and open PR**

```bash
git add README.md dist/
git commit -m "docs: document AWS Bedrock provider; rebuild dist"
git push -u origin feature/bedrock-provider
gh pr create --title "feat: AWS Bedrock provider (Converse API)" --body "..."
```

PR body: summarize spec decisions (Bearer-only auth, Converse API, cost normalization) and link the spec file. Per repo release flow, wait for user approval before merging.
