// Copies the prebuilt tree-sitter wasm files into dist/ after ncc builds
// dist/index.js. ncc does not bundle .wasm assets on its own, and
// src/context.js resolves grammar wasm paths at runtime relative to
// __dirname (see wasmCandidateDirs in src/context.js).
//
// Important: @vercel/ncc bundles everything into one flat dist/index.js, and
// __dirname inside that bundle resolves to dist/ itself (verified empirically
// - it does NOT mirror the original src/ nesting). So all 7 wasm files
// (tree-sitter.wasm + the 6 grammars) are copied FLAT into dist/, matching
// the `__dirname` candidate in wasmCandidateDirs().
//
// Separately, ncc's static analyzer conservatively bundles the *entire*
// tree-sitter-wasms/out directory (all ~36 grammars, ~49MB) into dist/out/
// as a side effect of context.js's fs.existsSync path-probing over a
// node_modules path built with literal segments. Those files are never read
// by context.js's actual resolution logic (which only ever checks the 7
// files below), so this script deletes dist/out/ after the ncc build to keep
// dist/ from shipping ~49MB of dead weight.
//
// Fails loudly (non-zero exit) if any expected source file is missing, so a
// broken/renamed dependency surfaces at build time, not at runtime in a PR
// review.

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

// Grammar wasm files, matching WASM_FILE_BY_GRAMMAR in src/context.js.
const GRAMMAR_WASM_FILES = [
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-ruby.wasm',
];

const CORE_WASM_FILE = 'tree-sitter.wasm';

// Tripwire: dist/ should only ever hold the bundled index.js plus the 7 wasm
// files copied above (a few MB total). If ncc's static analyzer regresses and
// starts bundling the full tree-sitter-wasms/out directory again (~49MB of
// unused grammars — see the dist/out cleanup below), that must fail the build
// loudly instead of silently shipping a bloated action.
const MAX_DIST_BYTES = 15 * 1024 * 1024;

function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function copyFileOrFail(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) {
    console.error(`copy-wasm: missing required wasm file: ${srcPath}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log(`copy-wasm: copied ${path.relative(REPO_ROOT, srcPath)} -> ${path.relative(REPO_ROOT, destPath)}`);
}

function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error(`copy-wasm: dist/ does not exist at ${DIST_DIR}; run "ncc build" first`);
    process.exit(1);
  }

  // Core web-tree-sitter runtime wasm (web-tree-sitter's own emscripten glue
  // resolves this relative to its own __dirname, which under ncc is dist/).
  copyFileOrFail(
    path.join(REPO_ROOT, 'node_modules', 'web-tree-sitter', CORE_WASM_FILE),
    path.join(DIST_DIR, CORE_WASM_FILE),
  );

  // Grammar wasm files, copied flat into dist/ to match the `__dirname`
  // candidate in wasmCandidateDirs() (src/context.js).
  for (const file of GRAMMAR_WASM_FILES) {
    copyFileOrFail(
      path.join(REPO_ROOT, 'node_modules', 'tree-sitter-wasms', 'out', file),
      path.join(DIST_DIR, file),
    );
  }

  // Clean up ncc's own conservative asset bundling: it copies the entire
  // tree-sitter-wasms/out directory (all ~36 grammars) into dist/out/ even
  // though context.js's resolution never reads from there. Remove it so
  // dist/ doesn't ship ~49MB of unused wasm files.
  const nccAutoAssetDir = path.join(DIST_DIR, 'out');
  if (fs.existsSync(nccAutoAssetDir)) {
    fs.rmSync(nccAutoAssetDir, { recursive: true, force: true });
    console.log(`copy-wasm: removed unused ncc-bundled asset dir ${path.relative(REPO_ROOT, nccAutoAssetDir)}`);
  }

  const distSizeBytes = dirSizeBytes(DIST_DIR);
  const distSizeMb = (distSizeBytes / (1024 * 1024)).toFixed(2);
  if (distSizeBytes > MAX_DIST_BYTES) {
    console.error(`copy-wasm: dist/ is ${distSizeMb}MB, exceeding the 15MB tripwire. This usually means ncc re-bundled the full tree-sitter-wasms grammar directory (~49MB) instead of just the 7 files this script copies — check that dist/out/ was actually removed above and that no new dynamic require.resolve()/fs path probing was added in src/context.js that would make ncc bundle assets conservatively.`);
    process.exit(1);
  }

  console.log(`copy-wasm: done (7 wasm files copied flat into dist/, total dist/ size ${distSizeMb}MB)`);
}

main();
