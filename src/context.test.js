const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  extractChangedSymbols,
  extractSymbolsRegex,
  findReferences,
  buildContextSection,
  gatherCodebaseContext,
} = require('./context');
const { matchPattern } = require('./index');

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

  test('changedLines reflects how many changed lines overlap the definition', async () => {
    const { p, src } = fx('sample.py');
    // sample.py's rate_for spans lines 1-2 (see the "changed line inside a
    // function" case above); widening the changed range to cover both lines
    // of the def should report changedLines: 2, not 1.
    const syms = await extractChangedSymbols(p, src, [{ start: 1, end: 2 }]);
    const rateFor = syms.find(s => s.name === 'rate_for');
    expect(rateFor).toBeDefined();
    expect(rateFor.changedLines).toBe(2);
  });

  test('one grammar failing to load falls back to regex for that language only, without poisoning others', async () => {
    const context = require('./context');
    context.__resetParsersForTest();
    const originalPythonWasm = context.WASM_FILE_BY_GRAMMAR.python;
    context.WASM_FILE_BY_GRAMMAR.python = 'tree-sitter-does-not-exist.wasm';

    try {
      // Python: the method-in-class case only yields ['total', 'Quote'] via a
      // real tree-sitter parse (both nodes overlap the changed range). The
      // regex fallback only scans the literal changed line ("return self.amount"),
      // which matches neither pattern, so an empty result proves the regex
      // path ran instead of tree-sitter for python specifically.
      const { p: pyPath, src: pySrc } = fx('sample.py');
      const pySyms = await extractChangedSymbols(pyPath, pySrc, [{ start: 9, end: 9 }]);
      expect(pySyms).toEqual([]);

      // Other grammars (javascript here) must still parse via tree-sitter,
      // unaffected by python's load failure.
      const { p: jsPath, src: jsSrc } = fx('sample.js');
      const jsSyms = await extractChangedSymbols(jsPath, jsSrc, [{ start: 8, end: 9 }]);
      expect(jsSyms.map(s => s.name)).toEqual(expect.arrayContaining(['open', 'Box']));
    } finally {
      context.WASM_FILE_BY_GRAMMAR.python = originalPythonWasm;
      context.__resetParsersForTest();
    }
  });
});

// Pins the built-action (dist/) wasm layout: scripts/copy-wasm.js copies
// tree-sitter.wasm and the grammar wasm files FLAT into dist/, because
// @vercel/ncc bundles context.js such that __dirname resolves to dist/
// itself at runtime (verified during Task 4 - see task-4-report.md). These
// tests simulate that flat layout against an isolated temp directory (via
// __setWasmBaseDirOverrideForTest, which replaces the whole candidate list -
// no node_modules path is ever consulted), so a future refactor that
// reorders or drops the __dirname candidate in wasmCandidateDirs() fails
// here instead of silently regressing to regex-only extraction in the built
// action.
describe('flat-dist wasm resolution (dist/ layout)', () => {
  const context = require('./context');
  let flatDir;

  beforeAll(() => {
    flatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlockqa-wasm-flat-'));
    const pythonWasmSrc = path.join(__dirname, '..', 'node_modules', 'tree-sitter-wasms', 'out', 'tree-sitter-python.wasm');
    fs.copyFileSync(pythonWasmSrc, path.join(flatDir, 'tree-sitter-python.wasm'));
  });

  afterAll(() => {
    context.__setWasmBaseDirOverrideForTest(null);
    context.__resetParsersForTest();
    fs.rmSync(flatDir, { recursive: true, force: true });
  });

  afterEach(() => {
    context.__setWasmBaseDirOverrideForTest(null);
  });

  test('resolveWasmPath finds a flat-copied wasm file with no node_modules candidate available', () => {
    context.__setWasmBaseDirOverrideForTest(flatDir);
    expect(context.resolveWasmPath('python')).toBe(path.join(flatDir, 'tree-sitter-python.wasm'));
  });

  test('a grammar missing from the flat dir throws (no node_modules fallback leaks through)', () => {
    context.__setWasmBaseDirOverrideForTest(flatDir);
    expect(() => context.resolveWasmPath('javascript')).toThrow(/tree-sitter wasm file not found/);
  });

  test('parses real python via tree-sitter loaded purely from the flat dir (end to end)', async () => {
    context.__setWasmBaseDirOverrideForTest(flatDir);
    context.__resetParsersForTest();

    const { p, src } = fx('sample.py');
    // Same case as "python: changed line inside a method yields method and
    // class" above; only a real tree-sitter parse (not the regex fallback)
    // yields both 'total' and 'Quote' for this changed range.
    const names = (await context.extractChangedSymbols(p, src, [{ start: 9, end: 9 }])).map(s => s.name);
    expect(names).toEqual(expect.arrayContaining(['total', 'Quote']));
  });
});

describe('extractSymbolsRegex fallback', () => {
  test('finds def/function/class/func/fn on changed lines', () => {
    const src = 'fn main() {\n}\nclass Foo:\n';
    const syms = extractSymbolsRegex('x.rs', src, [{ start: 1, end: 3 }]);
    expect(syms.map(s => s.name)).toEqual(expect.arrayContaining(['main', 'Foo']));
  });
});

describe('findReferences', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlockqa-ctx-fixture-'));
    execFileSync('git', ['init'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });

    fs.writeFileSync(path.join(repoDir, 'lib.py'), 'def rate_for(x):\n    return x * 2\n');

    // 12 caller lines: line N reads "xN = rate_for(N)". Enough lines that a
    // middle match (e.g. line 5) has full +/-3 context without hitting an edge,
    // and enough calls (>5) to exercise the per-symbol cap.
    const callerLines = [];
    for (let i = 1; i <= 12; i += 1) callerLines.push(`x${i} = rate_for(${i})`);
    fs.writeFileSync(path.join(repoDir, 'caller.py'), `${callerLines.join('\n')}\n`);

    fs.writeFileSync(path.join(repoDir, 'ignored.md'), 'See rate_for for details.\n');

    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const symbols = [{ name: 'rate_for', kind: 'function', file: 'lib.py' }];
  // Built lazily per-test (not as a describe-level const) because repoDir is
  // only assigned inside beforeAll, which runs after the describe body.
  const baseOpts = (extra) => ({ cwd: repoDir, changedFiles: ['lib.py'], ignorePatterns: ['*.md'], matchPattern, ...extra });

  test('excludes changed files and ignore-pattern matches', () => {
    const refs = findReferences(symbols, baseOpts());
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((r) => r.file !== 'lib.py')).toBe(true);
    expect(refs.every((r) => r.file !== 'ignored.md')).toBe(true);
    expect(refs.every((r) => r.file === 'caller.py')).toBe(true);
  });

  test('per-symbol cap honored', () => {
    const refs = findReferences(symbols, baseOpts({ perSymbolCap: 5 }));
    expect(refs.length).toBe(5);
    expect(refs.map((r) => r.line)).toEqual([1, 2, 3, 4, 5]);
  });

  test('snippet contains +/-3 context lines and the match line', () => {
    const refs = findReferences(symbols, baseOpts());
    const ref = refs.find((r) => r.line === 5);
    expect(ref).toBeDefined();
    const lines = ref.snippet.split('\n');
    expect(lines).toEqual(['x2 = rate_for(2)', 'x3 = rate_for(3)', 'x4 = rate_for(4)', 'x5 = rate_for(5)', 'x6 = rate_for(6)', 'x7 = rate_for(7)', 'x8 = rate_for(8)']);
  });

  test('symbol cap limits how many symbols are queried', () => {
    const manySymbols = Array.from({ length: 25 }, (_, i) => ({ name: `sym${i}`, kind: 'function', file: 'lib.py' }));
    manySymbols.push({ name: 'rate_for', kind: 'function', file: 'lib.py' });
    // rate_for is symbol #26 (index 25), beyond the default cap of 20, so it
    // should be dropped and produce no references even though it matches.
    const refs = findReferences(manySymbols, baseOpts());
    expect(refs.length).toBe(0);
  });
});

describe('buildContextSection', () => {
  test('returns empty string for no refs', () => {
    expect(buildContextSection([])).toBe('');
  });

  test('renders BEGIN/END markers, symbol headers, and file:line', () => {
    const refs = [
      { symbol: 'rate_for', file: 'caller.py', line: 4, snippet: 'a\nb\nc' },
    ];
    const section = buildContextSection(refs);
    expect(section).toContain('--- BEGIN CROSS-FILE CONTEXT (UNTRUSTED, read-only) ---');
    expect(section).toContain('--- END CROSS-FILE CONTEXT ---');
    expect(section).toContain('### rate_for');
    expect(section).toContain('caller.py:4');
  });

  test('char cap drops whole snippets deterministically', () => {
    const bigSnippet = 'x'.repeat(100);
    const refs = [
      { symbol: 'a', file: 'f1.py', line: 1, snippet: bigSnippet },
      { symbol: 'a', file: 'f2.py', line: 2, snippet: bigSnippet },
      { symbol: 'b', file: 'f3.py', line: 3, snippet: bigSnippet },
    ];
    const section = buildContextSection(refs, { maxChars: 200 });
    expect(section).toContain('f1.py:1');
    expect(section).not.toContain('f2.py:2');
    expect(section).not.toContain('f3.py:3');
    expect(section).not.toContain('### b');
    expect(section.length).toBeLessThanOrEqual(200 + 400);
  });

  test('prioritizes the symbol with more changed lines under a tight cap (I-A)', () => {
    // 'a' comes first in input order but only touched 1 changed line; 'b'
    // comes second but touched 5. The cap is tight enough for only one
    // symbol's ref to fit, so 'b' (higher priority) must survive, not 'a'.
    const snippet = 'x'.repeat(80);
    const refs = [
      { symbol: 'a', file: 'f1.py', line: 1, snippet, changedLines: 1 },
      { symbol: 'b', file: 'f2.py', line: 2, snippet, changedLines: 5 },
    ];
    const section = buildContextSection(refs, { maxChars: 120 });
    expect(section).toContain('### b');
    expect(section).toContain('f2.py:2');
    expect(section).not.toContain('### a');
    expect(section).not.toContain('f1.py:1');
  });

  test('an oversized group does not starve a smaller later group (I-B)', () => {
    // 'big' has a snippet too large to fit at all; 'small' comes after it and
    // easily fits. 'small' must still be rendered — the loop must skip 'big'
    // and continue, not bail out entirely on the first non-fitting group.
    const refs = [
      { symbol: 'big', file: 'big.py', line: 1, snippet: 'x'.repeat(500), changedLines: 1 },
      { symbol: 'small', file: 'small.py', line: 2, snippet: 'y', changedLines: 1 },
    ];
    const section = buildContextSection(refs, { maxChars: 200 });
    expect(section).not.toContain('### big');
    expect(section).toContain('### small');
    expect(section).toContain('small.py:2');
  });
});

describe('gatherCodebaseContext', () => {
  test('never throws and returns empty string for a nonexistent cwd', async () => {
    const result = await gatherCodebaseContext({
      files: ['a.py'],
      diff: '',
      parseRanges: () => [],
      ignorePatterns: [],
      matchPattern,
      maxChars: 1000,
      cwd: path.join(os.tmpdir(), 'sherlockqa-does-not-exist-xyz'),
    });
    expect(result).toBe('');
  });
});
