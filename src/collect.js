const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const yaml = require('js-yaml');
const { git, hasCheckout, ensureBaseCommit } = require('./context');

const DEFAULT_IGNORE_PATTERNS = '*.md,*.txt,package-lock.json,yarn.lock';

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

// With a checkout the working tree may hold the PR's code, so config is read from the base commit.
function loadRepoConfig(baseSha) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const candidates = ['.sherlockqa.yml', '.sherlockqa.yaml', '.sherlock.yml'];
  const fromBase = Boolean(baseSha) && hasCheckout(workspace);
  if (fromBase && !ensureBaseCommit(workspace, baseSha)) {
    core.warning('Repository config skipped: the base commit is unavailable.');
    return {};
  }
  for (const name of candidates) {
    let text;
    try {
      text = fromBase ? git(workspace, ['show', `${baseSha}:${name}`]) : fs.readFileSync(path.join(workspace, name), 'utf8');
    } catch {
      continue;
    }
    try {
      const parsed = yaml.load(text);
      if (parsed && typeof parsed === 'object') {
        core.info(`Loaded config from ${name}`);
        return parsed;
      }
    } catch (e) {
      core.warning(`Failed to parse ${name}: ${e.message}`);
    }
  }
  return {};
}

// Glob matcher supporting *, **, ?, and exact substring fallback for legacy patterns.
function matchPattern(filename, pattern) {
  if (!pattern) return false;
  // Exact match
  if (filename === pattern) return true;
  // Convert glob to regex
  if (pattern.includes('*') || pattern.includes('?')) {
    const regex = globToRegex(pattern);
    if (regex.test(filename)) return true;
    // Common case: "*.md" should also match "docs/foo.md"
    if (pattern.startsWith('*.') && filename.endsWith(pattern.slice(1))) return true;
    return false;
  }
  // Substring fallback (legacy behavior so existing configs keep working)
  return filename.includes(pattern);
}

function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function filterDiff(diffText, ignorePatterns) {
  const firstHeader = diffText.search(/^diff --git /m);
  const preamble = firstHeader === -1 ? diffText : diffText.slice(0, firstHeader);
  const kept = splitDiffByFile(diffText).filter(fileDiff => {
    let filePath = null;
    let oldPath = null;
    let renameTo = null;
    for (const rawLine of fileDiff.text.split('\n').slice(1)) {
      const line = rawLine.trimEnd();
      if (line.startsWith('@@')) break;
      if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length);
      else if (line.startsWith('--- a/')) oldPath = line.slice('--- a/'.length);
      else if (line.startsWith('+++ b/')) filePath = line.slice('+++ b/'.length);
      else if (line === '+++ /dev/null') filePath = oldPath;
    }
    filePath = filePath || renameTo || fileDiff.file;
    return !ignorePatterns.some(pattern => matchPattern(filePath, pattern));
  });
  return preamble + kept.map(fileDiff => fileDiff.text).join('');
}

function splitDiffByFile(diffText) {
  const fileDiffs = [];
  for (const line of diffText.split(/(?<=\n)/)) {
    if (line.startsWith('diff --git ')) {
      const header = line.trimEnd().match(/^diff --git a\/.* b\/(.*)$/);
      fileDiffs.push({ file: header ? header[1] : line.trimEnd(), text: '' });
    }
    if (fileDiffs.length === 0) continue;
    fileDiffs[fileDiffs.length - 1].text += line;
  }
  return fileDiffs;
}

function groupFileDiffs(fileDiffs, budgetChars) {
  const dirOf = (file) => file.slice(0, file.lastIndexOf('/') + 1);
  const sorted = [...fileDiffs].sort((a, b) =>
    dirOf(a.file).localeCompare(dirOf(b.file)) || b.text.length - a.text.length || a.file.localeCompare(b.file));

  const groups = [];
  let current = [];
  let currentSize = 0;
  for (const fileDiff of sorted) {
    if (fileDiff.text.length > budgetChars) {
      if (current.length > 0) groups.push(current);
      current = [];
      currentSize = 0;
      // Split only at @@ hunk boundaries; a single hunk over budget stays whole.
      const firstHunk = fileDiff.text.indexOf('\n@@') + 1;
      const header = fileDiff.text.slice(0, firstHunk);
      const hunks = fileDiff.text.slice(firstHunk).split(/(?=^@@ )/m);
      let piece = header;
      for (const hunk of hunks) {
        if (piece !== header && piece.length + hunk.length > budgetChars) {
          groups.push([{ file: fileDiff.file, text: piece }]);
          piece = header;
        }
        piece += hunk;
      }
      groups.push([{ file: fileDiff.file, text: piece }]);
      continue;
    }
    if (currentSize + fileDiff.text.length > budgetChars) {
      groups.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(fileDiff);
    currentSize += fileDiff.text.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

module.exports = {
  DEFAULT_IGNORE_PATTERNS,
  makeInputResolver,
  loadRepoConfig,
  matchPattern,
  globToRegex,
  filterDiff,
  splitDiffByFile,
  groupFileDiffs,
};
