const { execFileSync } = require('child_process');

const RULE_PATHS = ['CLAUDE.md', 'AGENTS.md', 'PATTERNS.md', '.cursorrules', '.github/copilot-instructions.md'];
const RULES_DIR = '.sherlockqa/rules/';

function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: 'pipe', maxBuffer: 10 * 1024 * 1024 });
}

// Reads from the base commit only, so a PR cannot rewrite the rules it is reviewed against.
function loadRuleFiles({ repoPath, baseSha, budgetChars = 20000 }) {
  const unavailable = { rules: [], warning: 'Repository rules skipped: the base commit is unavailable.' };

  try {
    git(repoPath, ['cat-file', '-e', `${baseSha}^{commit}`]);
  } catch {
    try {
      git(repoPath, ['fetch', '--depth=1', 'origin', baseSha]);
      git(repoPath, ['cat-file', '-e', `${baseSha}^{commit}`]);
    } catch {
      return unavailable;
    }
  }

  let ruleDirFiles = [];
  try {
    ruleDirFiles = git(repoPath, ['ls-tree', '--name-only', baseSha, RULES_DIR])
      .split('\n').filter(p => p.endsWith('.md')).sort();
  } catch {
    ruleDirFiles = [];
  }

  const rules = [];
  const skipped = [];
  let total = 0;
  for (const filePath of [...RULE_PATHS, ...ruleDirFiles]) {
    let text;
    try {
      text = git(repoPath, ['show', `${baseSha}:${filePath}`]);
    } catch {
      continue;
    }
    if (total + text.length > budgetChars) {
      skipped.push(filePath);
      continue;
    }
    total += text.length;
    rules.push({ path: filePath, text });
  }

  const warning = skipped.length > 0
    ? `Repository rules skipped because they exceed the ${budgetChars} character budget: ${skipped.join(', ')}`
    : null;
  return { rules, warning };
}

module.exports = { loadRuleFiles };
