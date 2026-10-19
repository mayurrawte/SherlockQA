const fs = require('fs');
const path = require('path');
const core = require('@actions/core');
const yaml = require('js-yaml');

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

function loadRepoConfig() {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const candidates = ['.sherlockqa.yml', '.sherlockqa.yaml', '.sherlock.yml'];
  for (const name of candidates) {
    const p = path.join(workspace, name);
    if (fs.existsSync(p)) {
      try {
        const parsed = yaml.load(fs.readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          core.info(`Loaded config from ${name}`);
          return parsed;
        }
      } catch (e) {
        core.warning(`Failed to parse ${name}: ${e.message}`);
      }
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

module.exports = {
  makeInputResolver,
  loadRepoConfig,
  matchPattern,
  globToRegex,
};
