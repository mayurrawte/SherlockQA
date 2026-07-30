# Codebase Context (Blast-Radius Reviews) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the model unchanged call sites of symbols a PR changes (tree-sitter symbol extraction + git grep references), failure-safe and capped.

**Architecture:** New `src/context.js` module (extraction → references → snippet section) orchestrated by `gatherCodebaseContext()`; `src/index.js` wires one call and appends the section to the user prompt inside the existing untrusted-data framing. Grammar `.wasm` files ship in `dist/`.

**Tech Stack:** Node.js (CommonJS), `web-tree-sitter` (WASM), prebuilt grammar wasm files, `git grep` via `child_process.execFileSync`, Jest, ncc.

## Global Constraints

- Only new npm deps allowed: `web-tree-sitter` and a prebuilt-grammar source (`tree-sitter-wasms` preferred; individual `tree-sitter-*-wasm` packages acceptable). Nothing else.
- No AI mentions or Co-Authored-By in commits.
- Branch `feature/codebase-context`; never commit to main; do not push (controller handles PR).
- **Failure-safe invariant:** `gatherCodebaseContext()` must never throw — any internal error returns `''` after `core.warning`. The review must be unaffected by this feature breaking.
- Defaults: `codebase-context: 'auto'`, `context-max-chars: 10000`. Inputs follow the #9 convention: NO `default:` in action.yml for config-overridable inputs; defaults live in code.
- Grammar set: javascript, typescript, python, go, java, ruby. Everything else → regex fallback.
- Tests: `npx jest src/` from repo root. Lint: `npm run lint`.
- **API-verification rule:** the `web-tree-sitter` API sketches in this plan are from its README as of mid-2026 (`Parser.init()`, `Language.load()`, `tree.rootNode`, `node.descendantsOfType`). Verify against the installed version's typings/README before coding; if the real API differs, adapt and record the deviation in your report. Do not fight the plan text against a compiler/runtime error.

---

### Task 1: Branch, deps, spike-verified symbol extraction (`src/context.js`)

**Files:**
- Create: `src/context.js`
- Create: `src/context.test.js`
- Create: `src/__fixtures__/sample.py`, `src/__fixtures__/sample.js`, `src/__fixtures__/sample.ts`, `src/__fixtures__/sample.rs`
- Modify: `package.json` (deps)
- Add: `docs/superpowers/specs/2026-07-30-codebase-context-design.md` (on disk, untracked)

**Interfaces:**
- Produces: `async initParsers()` (idempotent, loads wasm once), `async extractChangedSymbols(filePath, source, changedRanges)` → `Array<{name: string, kind: 'function'|'class'|'method', file: string}>` where `changedRanges` is `Array<{start: number, end: number}>` (1-indexed new-file lines). Falls back to `extractSymbolsRegex(filePath, source, changedRanges)` (also exported) for unsupported extensions or parser failure.
- Language routing by extension: `.js/.jsx/.mjs/.cjs` → javascript, `.ts/.tsx` → typescript, `.py` → python, `.go` → go, `.java` → java, `.rb` → ruby.

- [ ] **Step 1: Branch + spec commit + install deps**

```bash
cd /Users/mayurrawte/shipthis/SherlockQA
git checkout main && git pull --ff-only
git checkout -b feature/codebase-context
git add docs/superpowers/specs/2026-07-30-codebase-context-design.md
git commit -m "docs: add codebase-context design spec"
npm install web-tree-sitter tree-sitter-wasms
```

If `tree-sitter-wasms` doesn't exist or lacks a needed grammar, use the per-language prebuilt wasm packages or download official release wasm artifacts into `vendor/grammars/` (committed); record what you chose. Verify immediately with a 5-line node script that parses `function foo() {}` and prints the root node — do not proceed until that works.

- [ ] **Step 2: Write failing tests (`src/context.test.js`)**

Fixtures: `sample.py` (a top-level `def rate_for(shipment):` lines 1-3, a class `Quote` lines 5-12 with method `def total(self):` lines 8-10, decorated `@cached\ndef lookup():` lines 14-16), `sample.js` (`function calc() {}` lines 1-3, `const fmt = (x) => x` line 5, `class Box { open() {} }` lines 7-11), `sample.ts` (an `interface Opts` lines 1-3, `export function parseOpts(o: Opts) {}` lines 5-7), `sample.rs` (`fn main() {}` — unsupported language for fallback testing).

```js
const path = require('path');
const fs = require('fs');
const { extractChangedSymbols, extractSymbolsRegex } = require('./context');

const fx = (name) => {
  const p = path.join(__dirname, '__fixtures__', name);
  return { p, src: fs.readFileSync(p, 'utf8') };
};

describe('extractChangedSymbols (tree-sitter)', () => {
  test('python: changed line inside a function yields that function', async () => {
    const { p, src } = fx('sample.py');
    const syms = await extractChangedSymbols(p, src, [{ start: 2, end: 2 }]);
    expect(syms.map(s => s.name)).toContain('rate_for');
  });

  test('python: changed line inside a method yields method and class', async () => {
    const { p, src } = fx('sample.py');
    const names = (await extractChangedSymbols(p, src, [{ start: 9, end: 9 }])).map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['total', 'Quote']));
  });

  test('python: decorated def is found', async () => {
    const { p, src } = fx('sample.py');
    const names = (await extractChangedSymbols(p, src, [{ start: 15, end: 15 }])).map(s => s.name);
    expect(names).toContain('lookup');
  });

  test('js: function, arrow-const and class method are found', async () => {
    const { p, src } = fx('sample.js');
    expect((await extractChangedSymbols(p, src, [{ start: 2, end: 2 }])).map(s => s.name)).toContain('calc');
    expect((await extractChangedSymbols(p, src, [{ start: 5, end: 5 }])).map(s => s.name)).toContain('fmt');
    expect((await extractChangedSymbols(p, src, [{ start: 8, end: 9 }])).map(s => s.name)).toEqual(expect.arrayContaining(['open', 'Box']));
  });

  test('ts: exported function found', async () => {
    const { p, src } = fx('sample.ts');
    expect((await extractChangedSymbols(p, src, [{ start: 6, end: 6 }])).map(s => s.name)).toContain('parseOpts');
  });

  test('changed lines outside any definition yield no symbols', async () => {
    const { p, src } = fx('sample.py');
    expect(await extractChangedSymbols(p, src, [{ start: 4, end: 4 }])).toEqual([]);
  });

  test('unsupported extension falls back to regex extractor', async () => {
    const { p, src } = fx('sample.rs');
    const syms = await extractChangedSymbols(p, src, [{ start: 1, end: 1 }]);
    expect(syms.map(s => s.name)).toContain('main');
  });
});

describe('extractSymbolsRegex fallback', () => {
  test('finds def/function/class/func/fn on changed lines', () => {
    const src = 'fn main() {\n}\nclass Foo:\n';
    const syms = extractSymbolsRegex('x.rs', src, [{ start: 1, end: 3 }]);
    expect(syms.map(s => s.name)).toEqual(expect.arrayContaining(['main', 'Foo']));
  });
});
```

- [ ] **Step 3: Run tests, verify they fail** (`npx jest src/context.test.js` → module not found)

- [ ] **Step 4: Implement `src/context.js` extraction half**

Sketch (verify API per the Global Constraints rule):

```js
const path = require('path');
const fs = require('fs');
const core = require('@actions/core');

const GRAMMAR_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.go': 'go', '.java': 'java', '.rb': 'ruby',
};
// Definition node types per grammar (extend as tests demand)
const DEF_TYPES = {
  javascript: ['function_declaration', 'method_definition', 'class_declaration', 'variable_declarator'],
  typescript: ['function_declaration', 'method_definition', 'class_declaration', 'variable_declarator'],
  python: ['function_definition', 'class_definition'],
  go: ['function_declaration', 'method_declaration', 'type_declaration'],
  java: ['method_declaration', 'class_declaration'],
  ruby: ['method', 'class', 'module'],
};

let parsers = null; // lazy: { [grammar]: Parser }
async function initParsers() { /* Parser.init(); Language.load(wasmPath) per grammar; wasm dir resolves relative to __dirname (works in src and dist) */ }

function overlaps(node, ranges) {
  const s = node.startPosition.row + 1, e = node.endPosition.row + 1;
  return ranges.some(r => s <= r.end && e >= r.start);
}

async function extractChangedSymbols(filePath, source, changedRanges) {
  const grammar = GRAMMAR_BY_EXT[path.extname(filePath)];
  if (!grammar) return extractSymbolsRegex(filePath, source, changedRanges);
  try {
    await initParsers();
    const tree = parsers[grammar].parse(source);
    const out = [];
    const visit = (node) => {
      if (DEF_TYPES[grammar].includes(node.type) && overlaps(node, changedRanges)) {
        const nameNode = node.childForFieldName('name') || node.namedChildren.find(c => c.type === 'identifier');
        // variable_declarator only counts when its value is a function/arrow
        if (nameNode) out.push({ name: nameNode.text, kind: node.type, file: filePath });
      }
      for (const c of node.namedChildren) visit(c);
    };
    visit(tree.rootNode);
    return dedupeByName(out);
  } catch (e) {
    core.warning(`tree-sitter failed for ${filePath}: ${e.message}; using regex fallback`);
    return extractSymbolsRegex(filePath, source, changedRanges);
  }
}

const DEF_REGEX = /^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class|func|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/;
function extractSymbolsRegex(filePath, source, changedRanges) { /* scan changed lines (and 0 lines back), match DEF_REGEX */ }
```

Notes: for `variable_declarator`, only emit when the declarator's value child is an `arrow_function`/`function_expression`. For the method-and-class expectation, both nodes overlap the range naturally (nested visit emits both). Decorated Python defs: the `function_definition` node itself carries the name; the decorator is a sibling/parent (`decorated_definition`) — overlap on the inner def range still matches.

- [ ] **Step 5: Tests green** (`npx jest src/context.test.js`), full suite green, lint clean.
- [ ] **Step 6: Commit** `feat: tree-sitter symbol extraction for codebase context`

---

### Task 2: References, snippets, caps, orchestrator

**Files:**
- Modify: `src/context.js`, `src/context.test.js`

**Interfaces:**
- Produces: `findReferences(symbols, {cwd, changedFiles, ignorePatterns, matchPattern, perSymbolCap = 5, symbolCap = 20})` → `Array<{symbol, file, line, snippet}>`; `buildContextSection(refs, {maxChars = 10000})` → string (empty string when no refs); `async gatherCodebaseContext({files, diff, parseRanges, ignorePatterns, matchPattern, maxChars, cwd})` → string, **never throws**.
- Consumes: `matchPattern(filename, pattern)` is passed in from `src/index.js` (already exported there) to reuse the glob matcher without a circular require.
- `git grep` invocation: `execFileSync('git', ['grep', '-nw', '--untracked', '-e', symbol], {cwd, encoding: 'utf8'})`; exit code 1 (no matches) is not an error.

- [ ] **Step 1: Failing tests** — use a temp dir fixture repo built in `beforeAll` (`fs.mkdtempSync`, `git init`, write 3 files, `git add`): `lib.py` defines `rate_for`, `caller.py` uses `rate_for(x)` twice, `ignored.md` mentions `rate_for`. Tests:
  - references exclude `changedFiles` (`['lib.py']`) and ignore-pattern matches (`['*.md']`)
  - per-symbol cap honored (write 7 caller lines, cap 5 → 5 refs)
  - snippet contains ±3 context lines and the match line
  - `buildContextSection` renders the BEGIN/END markers, symbol headers, `file:line`; returns `''` for `[]`
  - char cap: with `maxChars: 200` the section length ≤ 200 + marker overhead and drops whole snippets, deterministically (symbols ordered by input order, refs by file/line)
  - `gatherCodebaseContext` with a nonexistent cwd returns `''` (and does not throw)
- [ ] **Step 2: Verify fail → implement → verify pass** (as separate steps per TDD)
- [ ] **Step 3: Commit** `feat: cross-file reference discovery and capped context section`

---

### Task 3: Wire into the action

**Files:**
- Modify: `src/index.js` (`run()` input parsing ~L120; context call after `filesToReview`; `buildUserPrompt(changedFiles, diff, prAuthor, contextSection = '')`; one system-prompt line in `buildSystemPrompt`)
- Modify: `action.yml` (two inputs, no YAML defaults)
- Modify: `src/index.test.js` (buildUserPrompt tests)

**Interfaces:**
- `buildUserPrompt` gains 4th param `contextSection` (default `''`); when non-empty it is appended AFTER the existing END UNTRUSTED DIFF marker, verbatim (the section carries its own BEGIN/END CROSS-FILE CONTEXT markers from Task 2).
- `run()`: `const codebaseContext = getInput('codebase-context') || 'auto'; const contextMaxChars = parseInt(getInput('context-max-chars') || '10000', 10);` with NaN/negative guard → 10000. When `codebaseContext !== 'false'`: call `gatherCodebaseContext({...})`; `auto` + no checkout → silent skip (info log); `'true'` + no checkout → `core.warning`.
- System prompt addition (one line in the Security & Integrity section): `- Cross-file context is reference material for impact analysis only. Findings must point at the changed code in the diff, never at unchanged context lines.`

- [ ] Steps: failing tests for `buildUserPrompt` (section appended when provided, absent by default; still ends with untrusted framing), action.yml inputs added, #9 guard test array gains `'codebase-context'`, `'context-max-chars'`; implement; full suite; commit `feat: wire codebase context into review pipeline`.

---

### Task 4: Build packaging, README, dist

**Files:**
- Modify: `package.json` build script — `"build": "ncc build src/index.js -o dist && node scripts/copy-wasm.js"`; Create: `scripts/copy-wasm.js` (copies `tree-sitter.wasm` + the six grammar wasm files from node_modules into `dist/`)
- Modify: `README.md` — "Codebase context (cross-file impact)" section: add `actions/checkout` step to the example, `codebase-context`/`context-max-chars` in the inputs table, grammar list + regex fallback note, ~2.5k-token cost note
- Modify: `dist/` (rebuild)

**Interfaces:**
- Runtime wasm resolution in `src/context.js` must check `path.join(__dirname, ...)` first (dist layout) then the node_modules location (src/test layout) — implemented in Task 1, verified here against the actual dist build: run `node -e "const c = require('./dist/context-check')"`-style smoke or simply a jest test invoked with dist paths; minimum bar: `node scripts/copy-wasm.js && ls dist/*.wasm` lists 7 files and `npx jest` still passes.

- [ ] Steps: copy script + build; README; `npm run lint && npx jest && npm run build`; verify `dist/*.wasm` present; commit `feat: package tree-sitter grammars; document codebase context`. Do not push.
