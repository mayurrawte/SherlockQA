const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const core = require('@actions/core');
const Parser = require('web-tree-sitter');

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

// Wasm file base names in the tree-sitter-wasms `out/` directory, keyed by grammar id.
const WASM_FILE_BY_GRAMMAR = {
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  java: 'tree-sitter-java.wasm',
  ruby: 'tree-sitter-ruby.wasm',
};

// Candidate directories to look for the prebuilt wasm files in, in order.
// Resolved relative to __dirname so this works whether context.js runs from
// src/ (tests, dev) or from the ncc-bundled dist/index.js (built action).
//
// Note on the dist case: @vercel/ncc bundles all modules into one flat file,
// and __dirname inside that bundle resolves to the *bundle's own output
// directory* (dist/), not to a path mirroring the original src/ nesting.
// scripts/copy-wasm.js copies the wasm files flat into dist/ to match this,
// so `__dirname` itself (the first entry below) is the real dist candidate.
// The `node_modules/tree-sitter-wasms/out` variants exist for src/test (dev)
// runs, where context.js runs from src/ and node_modules lives at the repo
// root (one level up).
// Test-only override: when set, wasmCandidateDirs() returns *only* this
// directory (no node_modules fallbacks at all), so tests can simulate the
// flat-dist layout in isolation - proving resolution works from a bare
// directory of wasm files, not merely because a node_modules candidate also
// happens to be reachable. See __setWasmBaseDirOverrideForTest below.
let wasmBaseDirOverride = null;

function wasmCandidateDirs() {
  if (wasmBaseDirOverride) return [wasmBaseDirOverride];
  return [
    __dirname,
    path.join(__dirname, 'node_modules', 'tree-sitter-wasms', 'out'),
    path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out'),
    path.join(__dirname, '..', '..', 'node_modules', 'tree-sitter-wasms', 'out'),
  ];
}

function resolveWasmPath(grammar) {
  const fileName = WASM_FILE_BY_GRAMMAR[grammar];
  for (const dir of wasmCandidateDirs()) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
  }
  // Deliberately NOT `require.resolve(`tree-sitter-wasms/out/${fileName}`)`
  // here: a dynamic (template-literal) require.resolve call is exactly what
  // makes @vercel/ncc's static analyzer bundle the *entire* target directory
  // as assets (all ~36 tree-sitter-wasms grammars, ~49MB) into dist/ "just in
  // case" — even though wasmCandidateDirs() above already covers both the
  // dist and src/test layouts. Throwing here keeps that bloat out of dist/;
  // the caller (initParsers) catches this per-grammar and falls back to
  // regex extraction, same as any other missing-wasm failure.
  throw new Error(`tree-sitter wasm file not found for grammar "${grammar}" (${fileName}); checked: ${wasmCandidateDirs().map((d) => path.join(d, fileName)).join(', ')}`);
}

let parsers = null; // lazy: { [grammar]: Parser instance }, missing key => that grammar failed to load
let initPromise = null;

async function initParsers() {
  if (parsers) return parsers;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await Parser.init();
    const loaded = {};
    for (const grammar of Object.keys(WASM_FILE_BY_GRAMMAR)) {
      // Isolate failures per grammar: one bad/missing wasm file must not
      // poison the others or permanently wedge the cached init promise.
      try {
        const wasmPath = resolveWasmPath(grammar);
        const language = await Parser.Language.load(wasmPath);
        const parser = new Parser();
        parser.setLanguage(language);
        loaded[grammar] = parser;
      } catch (e) {
        core.warning(`tree-sitter: failed to load grammar "${grammar}": ${e.message}; falling back to regex for this language`);
      }
    }
    parsers = loaded;
    return parsers;
  })();
  return initPromise;
}

// Test-only seam: clears the module-level parser cache so tests can force a
// fresh initParsers() run (e.g. after mutating WASM_FILE_BY_GRAMMAR to
// simulate a grammar load failure). Not part of the documented interface.
function __resetParsersForTest() {
  parsers = null;
  initPromise = null;
}

// Test-only seam: forces wasmCandidateDirs() to return only `dir` (or, when
// called with a falsy value, restores the normal __dirname-relative
// candidate list). Lets tests simulate the flat-dist runtime layout (see
// scripts/copy-wasm.js) against an arbitrary temp directory, without any
// node_modules candidate being reachable as a fallback. Not part of the
// documented public interface.
function __setWasmBaseDirOverrideForTest(dir) {
  wasmBaseDirOverride = dir || null;
}

function overlaps(node, ranges) {
  const s = node.startPosition.row + 1;
  const e = node.endPosition.row + 1;
  return ranges.some((r) => s <= r.end && e >= r.start);
}

// Counts how many changed lines (from `ranges`) fall within [s, e] (1-indexed,
// inclusive). Used to prioritize symbols by how much of their definition
// actually changed (spec step 5).
function countChangedLines(s, e, ranges) {
  let count = 0;
  for (const r of ranges) {
    const start = Math.max(s, r.start);
    const end = Math.min(e, r.end);
    if (start <= end) count += end - start + 1;
  }
  return count;
}

// Merges duplicate symbols (same key), summing changedLines across the
// duplicates so a symbol touched by multiple overlapping ranges/entries keeps
// its full weight for priority ordering.
function dedupeByName(symbols) {
  const seen = new Map();
  const out = [];
  for (const sym of symbols) {
    const key = `${sym.kind}:${sym.name}:${sym.file}`;
    const existing = seen.get(key);
    if (existing) {
      existing.changedLines = (existing.changedLines || 0) + (sym.changedLines || 0);
      continue;
    }
    const copy = { ...sym };
    seen.set(key, copy);
    out.push(copy);
  }
  return out;
}

function kindForNodeType(nodeType, insideClass) {
  if (nodeType.includes('class')) return 'class';
  if (nodeType.includes('module')) return 'class';
  if (nodeType.includes('method')) return 'method';
  // python/ruby-style bare `function_definition`/`def`: nested in a class means it's a method.
  if (insideClass) return 'method';
  return 'function';
}

function isFunctionLike(node) {
  return node && (node.type === 'arrow_function' || node.type === 'function_expression' || node.type === 'function');
}

async function extractChangedSymbols(filePath, source, changedRanges) {
  const grammar = GRAMMAR_BY_EXT[path.extname(filePath)];
  if (!grammar) return extractSymbolsRegex(filePath, source, changedRanges);

  try {
    const loadedParsers = await initParsers();
    const tree = loadedParsers[grammar].parse(source);
    const out = [];

    const classLikeTypes = ['class_declaration', 'class_definition', 'class', 'module'];

    const visit = (node, insideClass) => {
      if (DEF_TYPES[grammar].includes(node.type) && overlaps(node, changedRanges)) {
        const s = node.startPosition.row + 1;
        const e = node.endPosition.row + 1;
        const changedLines = countChangedLines(s, e, changedRanges);
        if (node.type === 'variable_declarator') {
          const valueNode = node.childForFieldName('value');
          if (isFunctionLike(valueNode)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) out.push({ name: nameNode.text, kind: 'function', file: filePath, changedLines });
          }
        } else {
          const nameNode = node.childForFieldName('name')
            || node.namedChildren.find((c) => c.type === 'identifier' || c.type === 'constant' || c.type === 'type_identifier');
          if (nameNode) {
            out.push({ name: nameNode.text, kind: kindForNodeType(node.type, insideClass), file: filePath, changedLines });
          }
        }
      }
      const nowInsideClass = insideClass || classLikeTypes.includes(node.type);
      for (const child of node.namedChildren) visit(child, nowInsideClass);
    };

    visit(tree.rootNode, false);
    return dedupeByName(out);
  } catch (e) {
    core.warning(`tree-sitter failed for ${filePath}: ${e.message}; using regex fallback`);
    return extractSymbolsRegex(filePath, source, changedRanges);
  }
}

const DEF_REGEX = /^\s*(?:export\s+)?(?:async\s+)?(?:def|function|class|func|fn)\s+([A-Za-z_][A-Za-z0-9_]*)/;

function kindForRegexKeyword(line) {
  return line.includes('class') ? 'class' : 'function';
}

function extractSymbolsRegex(filePath, source, changedRanges) {
  const lines = source.split('\n');
  const out = [];
  for (const range of changedRanges) {
    const start = Math.max(1, range.start);
    const end = Math.min(lines.length, range.end);
    for (let lineNo = start; lineNo <= end; lineNo += 1) {
      const line = lines[lineNo - 1];
      if (line === undefined) continue;
      const match = DEF_REGEX.exec(line);
      if (match) {
        out.push({ name: match[1], kind: kindForRegexKeyword(match[0]), file: filePath, changedLines: 1 });
      }
    }
  }
  return dedupeByName(out);
}

// Scans a unified diff for `file`'s deleted ("-") lines and matches them
// against DEF_REGEX (the same pattern extractSymbolsRegex uses) to find
// symbols removed entirely by this PR (spec step 2). This runs against the
// diff text itself rather than a parsed source tree, because deleted code no
// longer exists on disk to tree-sitter-parse - regex over the "-" lines is
// the only source of truth available. changedLines counts how many deleted
// lines matched a definition for that name, so deleted symbols compete for
// priority/caps on equal footing with changed ones (see sortSymbolsByPriority).
function extractDeletedSymbols(diffText, file) {
  const out = [];
  let currentFile = null;
  for (const line of diffText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      continue;
    }
    if (!currentFile) {
      // "--- a/<path>" identifies the pre-image file whose "-" lines we scan;
      // present for modified AND fully-deleted files alike (deleted files
      // additionally have "+++ /dev/null", which we don't need here).
      if (line.startsWith('--- a/')) currentFile = line.slice(6);
      continue;
    }
    if (currentFile !== file) continue;
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const match = DEF_REGEX.exec(line.slice(1));
    if (match) {
      out.push({ name: match[1], kind: 'deleted', file, changedLines: 1 });
    }
  }
  return dedupeByName(out);
}

// --- Reference discovery -------------------------------------------------

// Parses one `git grep -n` output line ("path:lineno:content") into its
// parts. Uses indexOf rather than split(':') because match content itself
// may contain colons.
function parseGrepLine(line) {
  const firstColon = line.indexOf(':');
  if (firstColon === -1) return null;
  const file = line.slice(0, firstColon);
  const rest = line.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  if (secondColon === -1) return null;
  const lineNo = parseInt(rest.slice(0, secondColon), 10);
  if (Number.isNaN(lineNo)) return null;
  return { file, line: lineNo };
}

// Runs `git grep -nw --untracked -e <symbol>` at cwd. Exit code 1 means "no
// matches" (not an error, per git's convention); any other failure (not a
// git repo, git missing, etc.) is logged and treated as "no references"
// rather than propagated, so a single bad symbol can't break the pipeline.
function grepSymbol(symbolName, cwd) {
  try {
    const out = execFileSync('git', ['grep', '-nw', '--untracked', '-e', symbolName], { cwd, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // no matches, not an error
    core.warning(`git grep failed for symbol "${symbolName}": ${e.message}`);
    return [];
  }
}

function isIgnored(file, ignorePatterns, matchPattern) {
  if (!ignorePatterns || !matchPattern) return false;
  return ignorePatterns.some((pattern) => matchPattern(file, pattern));
}

function sortByFileThenLine(a, b) {
  return a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file);
}

// Reads +/-3 lines of context around lineNo (1-indexed) in file, relative to
// cwd. Returns '' if the file can't be read (deleted/binary/etc.) rather
// than throwing, so one unreadable hit doesn't drop the whole symbol.
function readSnippet(cwd, file, lineNo) {
  try {
    const content = fs.readFileSync(path.join(cwd, file), 'utf8');
    const lines = content.split('\n');
    const start = Math.max(1, lineNo - 3);
    const end = Math.min(lines.length, lineNo + 3);
    const out = [];
    for (let i = start; i <= end; i += 1) out.push(lines[i - 1]);
    return out.join('\n');
  } catch (e) {
    return '';
  }
}

// Finds unchanged-code references to `symbols` via `git grep`, dropping hits
// in changed files, ignore-pattern matches, and the symbol's own definition
// file, and keeping at most `perSymbolCap` reference sites per symbol (after
// capping the symbol list itself to `symbolCap`).
function findReferences(symbols, options = {}) {
  const {
    cwd = process.cwd(),
    changedFiles = [],
    ignorePatterns = [],
    matchPattern,
    perSymbolCap = 5,
    symbolCap = 20,
  } = options;

  const changedSet = new Set(changedFiles);
  const cappedSymbols = symbols.slice(0, symbolCap);
  const refs = [];

  for (const sym of cappedSymbols) {
    const lines = grepSymbol(sym.name, cwd);
    const hits = [];

    for (const rawLine of lines) {
      const parsed = parseGrepLine(rawLine);
      if (!parsed) continue;
      const { file, line } = parsed;
      if (changedSet.has(file)) continue;
      if (file === sym.file) continue;
      if (isIgnored(file, ignorePatterns, matchPattern)) continue;
      hits.push({ file, line });
    }

    hits.sort(sortByFileThenLine);
    const capped = hits.slice(0, perSymbolCap);

    for (const hit of capped) {
      refs.push({
        symbol: sym.name,
        kind: sym.kind,
        symbolFile: sym.file,
        file: hit.file,
        line: hit.line,
        snippet: readSnippet(cwd, hit.file, hit.line),
        changedLines: sym.changedLines || 0,
      });
    }
  }

  return refs;
}

// --- Context section rendering -------------------------------------------

const BEGIN_MARKER = '--- BEGIN CROSS-FILE CONTEXT (UNTRUSTED, read-only) ---';
const END_MARKER = '--- END CROSS-FILE CONTEXT ---';
const DESCRIPTION = [
  'Unchanged code that references symbols this PR modifies. Check these call',
  'sites for breakage (signature changes, renamed/removed symbols, changed',
  'return shapes). Do not review this code itself.',
].join('\n');

// Groups refs by symbol, preserving the order symbols were first seen in,
// then sorts groups by total changed-line count (desc) so higher-priority
// symbols (more of their definition changed) are rendered - and survive the
// maxChars cap - first. Ties keep the original (first-seen) order: Array.sort
// is stable, and each group's rank is (-changedLines, firstSeenIndex), so
// equal-changedLines groups never swap relative order.
function groupBySymbolInOrder(refs) {
  const order = [];
  const groups = new Map();
  for (const ref of refs) {
    if (!groups.has(ref.symbol)) {
      groups.set(ref.symbol, []);
      order.push(ref.symbol);
    }
    groups.get(ref.symbol).push(ref);
  }
  const grouped = order.map((symbol, index) => {
    const symRefs = groups.get(symbol);
    const changedLines = Math.max(0, ...symRefs.map((r) => r.changedLines || 0));
    // kind/symbolFile are properties of the *symbol*, not the individual
    // reference site, so every ref in the group carries the same value here -
    // take the first one seen. Absent for refs built by hand (e.g. older
    // tests / callers that don't pass them), which keeps the header untagged.
    const kind = symRefs[0]?.kind;
    const symbolFile = symRefs[0]?.symbolFile;
    return {
      symbol,
      refs: symRefs.slice().sort(sortByFileThenLine),
      changedLines,
      kind,
      symbolFile,
      index,
    };
  });
  grouped.sort((a, b) => (b.changedLines - a.changedLines) || (a.index - b.index));
  return grouped;
}

// "### <name> (deleted from <file>)" for a symbol removed by this PR, or
// "### <name> (changed in <file>)" for one that still exists but was
// modified - falls back to a bare "### <name>" when the symbol's own file
// isn't known (e.g. refs built without kind/symbolFile).
function renderGroupHeader(group) {
  if (!group.symbolFile) return `### ${group.symbol}\n`;
  const verb = group.kind === 'deleted' ? 'deleted from' : 'changed in';
  return `### ${group.symbol} (${verb} ${group.symbolFile})\n`;
}

function renderRefBlock(ref) {
  const indented = ref.snippet.split('\n').map((l) => `    ${l}`).join('\n');
  return `${ref.file}:${ref.line}\n${indented}\n`;
}

// Renders refs into the BEGIN/END CROSS-FILE CONTEXT block, capping the
// rendered symbol/ref content at maxChars. The BEGIN/END markers and
// description are fixed overhead outside that cap. Drop order is
// deterministic: symbols in priority order (most changed lines first, ties
// by input order), refs within a symbol by file/line; within a group, once a
// ref no longer fits, that ref and the rest of the group's refs are dropped
// whole (no partial snippets) — but later, smaller groups are still tried,
// so one oversized group can't starve everything after it.
function buildContextSection(refs, options = {}) {
  const { maxChars = 10000 } = options;
  if (!refs || refs.length === 0) return '';

  const groups = groupBySymbolInOrder(refs);
  let content = '';

  for (const group of groups) {
    const header = renderGroupHeader(group);
    let size = header.length;
    const fittedBlocks = [];

    for (const ref of group.refs) {
      const block = renderRefBlock(ref);
      if (content.length + size + block.length > maxChars) break;
      fittedBlocks.push(block);
      size += block.length;
    }

    if (fittedBlocks.length === 0) continue; // nothing fit for this group; try the next (smaller) one

    content += header + fittedBlocks.join('');
  }

  if (content === '') return '';

  return `${BEGIN_MARKER}\n${DESCRIPTION}\n\n${content}${END_MARKER}`;
}

// --- Orchestrator ----------------------------------------------------------

// Merges symbols across files/extraction passes by name, summing changedLines
// (spec step 5 priority weight) across duplicates rather than keeping only
// the first occurrence's count.
function dedupeSymbolsByName(symbols) {
  const seen = new Map();
  const out = [];
  for (const sym of symbols) {
    const existing = seen.get(sym.name);
    if (existing) {
      existing.changedLines = (existing.changedLines || 0) + (sym.changedLines || 0);
      continue;
    }
    const copy = { ...sym };
    seen.set(sym.name, copy);
    out.push(copy);
  }
  return out;
}

// Orders symbols by priority for downstream reference lookup and rendering:
// most changed lines first, ties broken by the original (first-seen) order.
// Stable tiebreak is explicit here (not relied on Array.sort's own stability)
// so the ordering contract holds regardless of engine.
function sortSymbolsByPriority(symbols) {
  return symbols
    .map((sym, index) => ({ sym, index }))
    .sort((a, b) => (b.sym.changedLines || 0) - (a.sym.changedLines || 0) || a.index - b.index)
    .map((entry) => entry.sym);
}

// Full pipeline: detect a usable checkout, extract changed symbols from each
// changed file, find cross-file references to them, and render the capped
// context section. NEVER throws — any failure (missing checkout, bad diff,
// parse error, git grep failure, etc.) is logged via core.warning and
// resolves to ''; the feature must never fail a review.
async function gatherCodebaseContext(options = {}) {
  try {
    const {
      files = [],
      diff = '',
      parseRanges,
      ignorePatterns = [],
      matchPattern,
      maxChars = 10000,
      cwd = process.cwd(),
    } = options;

    if (!cwd || !fs.existsSync(cwd)) return '';

    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { cwd, encoding: 'utf8' });
    } catch (e) {
      core.warning(`codebase context: no git checkout detected at ${cwd}; skipping`);
      return '';
    }

    const allSymbols = [];
    for (const file of files) {
      // A fully-deleted file has no on-disk source to read or parse - that's
      // fine, it just means the "changed" (still-existing-code) extraction
      // path below has nothing to do for it. The "deleted" path further down
      // works entirely off the diff text, so it still runs for such files.
      let source = null;
      try {
        source = fs.readFileSync(path.join(cwd, file), 'utf8');
      } catch (e) {
        source = null; // file not on disk (deleted, renamed, etc.)
      }

      if (source !== null) {
        let changedRanges = [];
        try {
          changedRanges = (typeof parseRanges === 'function' ? parseRanges(diff, file) : []) || [];
        } catch (e) {
          core.warning(`codebase context: failed to parse changed ranges for ${file}: ${e.message}`);
          changedRanges = [];
        }

        if (changedRanges.length > 0) {
          try {
            const symbols = await extractChangedSymbols(file, source, changedRanges);
            allSymbols.push(...symbols);
          } catch (e) {
            core.warning(`codebase context: symbol extraction failed for ${file}: ${e.message}`);
          }
        }
      }

      // Deleted-symbol extraction (spec step 2): scans the diff's own "-"
      // lines for definitions removed by this PR. Independent of whether the
      // file still exists on disk or had any surviving changed ranges, so a
      // PR that deletes a function still produces context for it.
      try {
        const deletedSymbols = extractDeletedSymbols(diff, file);
        allSymbols.push(...deletedSymbols);
      } catch (e) {
        core.warning(`codebase context: deleted-symbol extraction failed for ${file}: ${e.message}`);
      }
    }

    const symbols = sortSymbolsByPriority(dedupeSymbolsByName(allSymbols));
    if (symbols.length === 0) return '';

    const refs = findReferences(symbols, { cwd, changedFiles: files, ignorePatterns, matchPattern });
    return buildContextSection(refs, { maxChars });
  } catch (e) {
    core.warning(`codebase context: failed, falling back to diff-only: ${e.message}`);
    return '';
  }
}

module.exports = {
  initParsers,
  extractChangedSymbols,
  extractSymbolsRegex,
  extractDeletedSymbols,
  findReferences,
  buildContextSection,
  gatherCodebaseContext,
  // Test-only seams (not part of the documented public interface).
  WASM_FILE_BY_GRAMMAR,
  resolveWasmPath,
  __resetParsersForTest,
  __setWasmBaseDirOverrideForTest,
};
