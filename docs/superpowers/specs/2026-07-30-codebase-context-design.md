# Codebase Context (Blast-Radius Reviews) — Issue #31

**Date:** 2026-07-30
**Status:** Approved design, pending implementation

## Goal

Close the diff-only gap: when a PR changes a function/class, show the model the *unchanged* code that references it, so it can flag breakage in callers and stop false-positiving on context it can't see (both findings on shipthisco/pynexus#939 were this failure mode).

Approach validated against open source practice: aider's tree-sitter repo map (the ecosystem-standard approach), with `git grep` for reference discovery.

## Decisions

- **Symbol extraction: `web-tree-sitter` (WASM)** — precise AST-based definition extraction, no native builds, bundleable. First intentional npm dependency beyond the GitHub toolkit; approved by owner 2026-07-30.
- **ABI lock:** `web-tree-sitter` and `tree-sitter-wasms` are pinned to exact versions (`0.20.8` / `0.1.13`, no caret) in `package.json`. The prebuilt `.wasm` grammar binaries and the `web-tree-sitter` runtime must be built against a compatible wasm ABI/loader shape — verified `0.20.8` + `0.1.13` load correctly together via spike; newer `web-tree-sitter` (0.26.x) fails to load these same wasm files (`getDylinkMetadata` error). Bump these two packages together only, re-running the spike check, never independently.
- **Grammars:** JavaScript (covers JSX), TypeScript, Python, Go, Java, Ruby — prebuilt `.wasm` files (e.g. from the `tree-sitter-wasms` package or per-grammar prebuilds), copied into `dist/` at build time. Files outside these languages use a regex fallback (function/class/def patterns).
- **Reference discovery: `git grep -nw <symbol>`** via child_process against the checked-out tree — fast, language-agnostic, zero extra deps. Requires the consumer workflow to run `actions/checkout` before SherlockQA.
- **Activation: automatic, failure-safe.** New input `codebase-context` (default `'auto'`): `auto` = enable when the workspace contains a git checkout of the PR head; `true` = warn if no checkout; `false` = off. ANY error in the context pipeline → `core.warning` + fall back to diff-only. The feature can never fail a review.

## Pipeline

Runs after `filesToReview` is computed, before prompt building:

1. **Detect checkout** — changed file paths exist on disk and `git rev-parse --git-dir` succeeds. Otherwise skip (log once at `auto`).
2. **Extract changed symbols** — for each changed file with a supported grammar: parse the on-disk file with tree-sitter; collect named definitions (functions, methods, classes) whose span overlaps any changed-line range from the diff (`parseDiffForLinePositions`-style hunk parsing gives new-file line ranges; deleted-symbol names come from `-` lines via regex). Regex fallback for unsupported languages: `def|function|class|func|fn` definition patterns on changed lines.
3. **Find external references** — for each symbol (deduped, max 20 symbols): `git grep -nw --untracked -e <symbol>` at repo root; drop hits in changed files, in `ignore-patterns` matches, and in the symbol's own definition file when it only re-matches the definition; keep at most 5 reference sites per symbol.
4. **Build snippets** — for each kept hit, read ±3 lines around the match. Dedupe overlapping snippets per file.
5. **Cap and label** — total context section ≤ 10,000 chars (drop lowest-priority snippets beyond the cap; priority = symbols with the most changed lines first). Rendered into the user prompt as:

```
--- BEGIN CROSS-FILE CONTEXT (UNTRUSTED, read-only) ---
Unchanged code that references symbols this PR modifies. Check these call
sites for breakage (signature changes, renamed/removed symbols, changed
return shapes). Do not review this code itself.

### processShipment (changed in app/services/rates.py)
app/api/quotes.py:88
    <snippet>
...
--- END CROSS-FILE CONTEXT ---
```

Same injection-hardening treatment as the diff (untrusted data, never instructions).

6. **Prompt system rule** — one added line in the system prompt: cross-file context is reference material for impact analysis; findings there must point at the *changed* code that breaks it (file/line of the diff side).

## Structure

New file `src/context.js` (the single-file `src/index.js` is already ~1400 lines):
- `detectCheckout(files)` → bool
- `extractChangedSymbols(file, changedRanges, source)` → `[{name, kind, file}]` (tree-sitter with regex fallback)
- `findReferences(symbols, {ignorePatterns, changedFiles})` → `[{symbol, file, line, snippet}]` (git grep + fs reads)
- `buildContextSection(refs, {maxChars})` → string
- `gatherCodebaseContext(opts)` → orchestrator, returns `''` on any failure (with warning)

`src/index.js`: input parsing, one call to `gatherCodebaseContext`, append to user prompt in `buildUserPrompt` (new optional param).

## Build

`npm run build` gains a step copying grammar `.wasm` files (and `tree-sitter.wasm`) next to `dist/index.js`; runtime loads them relative to `__dirname`. Verify ncc asset handling; a plain `cp` in the build script is acceptable.

## Inputs (action.yml)

| Input | Default | Description |
|---|---|---|
| `codebase-context` | `auto` | Cross-file impact context: `auto` (on when the repo is checked out), `true`, `false` |
| `context-max-chars` | `10000` | Cap on the cross-file context section |

## Testing

- Symbol extraction: fixture files per language (JS/TS/Python at minimum) with changed-range overlap cases: function, method in class, arrow function assigned to const, decorated Python def; changed lines outside any def → no symbols.
- Regex fallback for an unsupported extension.
- Reference filtering: changed files excluded, ignore-patterns respected, per-symbol cap, total char cap (drop order deterministic).
- Failure-safety: git grep failing / missing file / parse error → `''` + no throw.
- Prompt assembly: section present only when non-empty; wrapped in the untrusted markers.

## Docs

README: new "Codebase context" section — add `actions/checkout` to the example workflow, explain auto mode, note the supported grammar list and the regex fallback, token-cost implication (~2.5k tokens max at default cap).

## Out of scope

Full repo map / ranking (aider-style PageRank), embeddings, cross-repo context, MCP sources, persistent index caching between runs.
