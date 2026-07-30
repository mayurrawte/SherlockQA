const path = require('path');
const fs = require('fs');
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
// src/ (tests, dev) or dist/ (built action, one directory deeper than
// node_modules).
function wasmCandidateDirs() {
  return [
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
  // Last resort: let node resolve the package location directly.
  return require.resolve(`tree-sitter-wasms/out/${fileName}`);
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

function overlaps(node, ranges) {
  const s = node.startPosition.row + 1;
  const e = node.endPosition.row + 1;
  return ranges.some((r) => s <= r.end && e >= r.start);
}

function dedupeByName(symbols) {
  const seen = new Set();
  const out = [];
  for (const sym of symbols) {
    const key = `${sym.kind}:${sym.name}:${sym.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sym);
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
        if (node.type === 'variable_declarator') {
          const valueNode = node.childForFieldName('value');
          if (isFunctionLike(valueNode)) {
            const nameNode = node.childForFieldName('name');
            if (nameNode) out.push({ name: nameNode.text, kind: 'function', file: filePath });
          }
        } else {
          const nameNode = node.childForFieldName('name')
            || node.namedChildren.find((c) => c.type === 'identifier' || c.type === 'constant' || c.type === 'type_identifier');
          if (nameNode) {
            out.push({ name: nameNode.text, kind: kindForNodeType(node.type, insideClass), file: filePath });
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
        out.push({ name: match[1], kind: kindForRegexKeyword(match[0]), file: filePath });
      }
    }
  }
  return dedupeByName(out);
}

module.exports = {
  initParsers,
  extractChangedSymbols,
  extractSymbolsRegex,
  // Test-only seams (not part of the documented public interface).
  WASM_FILE_BY_GRAMMAR,
  __resetParsersForTest,
};
