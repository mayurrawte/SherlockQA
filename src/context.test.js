const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadRuleFiles } = require('./context');
const { buildSystemPrompt } = require('./review');

const tmpDirs = [];

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-ctx-'));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function initRepo(dir) {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

function commit(dir, files, message) {
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadRuleFiles', () => {
  test('reads the base commit version, not the PR version', () => {
    const repo = mkTmp();
    initRepo(repo);
    const baseSha = commit(repo, { 'CLAUDE.md': 'base rules' }, 'base');
    commit(repo, { 'CLAUDE.md': 'pr rewrote the rules' }, 'pr');
    const { rules, warning } = loadRuleFiles({ repoPath: repo, baseSha });
    expect(rules).toEqual([{ path: 'CLAUDE.md', text: 'base rules' }]);
    expect(warning).toBeNull();
  });

  test('returns known files in order and skips missing ones', () => {
    const repo = mkTmp();
    initRepo(repo);
    const baseSha = commit(repo, {
      'PATTERNS.md': 'p',
      'AGENTS.md': 'a',
      '.github/copilot-instructions.md': 'c',
      'CLAUDE.md': 'cl',
    }, 'base');
    const { rules } = loadRuleFiles({ repoPath: repo, baseSha });
    expect(rules.map(r => r.path)).toEqual(['CLAUDE.md', 'AGENTS.md', 'PATTERNS.md', '.github/copilot-instructions.md']);
  });

  test('sherlockqa rules come back sorted, markdown only, after the named files', () => {
    const repo = mkTmp();
    initRepo(repo);
    const baseSha = commit(repo, {
      '.sherlockqa/rules/b.md': 'B',
      '.sherlockqa/rules/a.md': 'A',
      '.sherlockqa/rules/notes.txt': 'ignored',
      'CLAUDE.md': 'top',
    }, 'base');
    const { rules } = loadRuleFiles({ repoPath: repo, baseSha });
    expect(rules.map(r => r.path)).toEqual(['CLAUDE.md', '.sherlockqa/rules/a.md', '.sherlockqa/rules/b.md']);
  });

  test('skips a file that would cross the budget, names it, and keeps later smaller files', () => {
    const repo = mkTmp();
    initRepo(repo);
    const baseSha = commit(repo, {
      'CLAUDE.md': 'small',
      'AGENTS.md': 'x'.repeat(25000),
      'PATTERNS.md': 'also small',
    }, 'base');
    const { rules, warning } = loadRuleFiles({ repoPath: repo, baseSha });
    expect(rules.map(r => r.path)).toEqual(['CLAUDE.md', 'PATTERNS.md']);
    expect(warning).toContain('AGENTS.md');
  });

  test('a directory without .git returns no rules and a warning', () => {
    const dir = mkTmp();
    const { rules, warning } = loadRuleFiles({ repoPath: dir, baseSha: 'abc123' });
    expect(rules).toEqual([]);
    expect(warning).toMatch(/base commit/);
  });

  test('fetches a missing base commit from origin', () => {
    const origin = mkTmp();
    git(origin, 'init', '-q', '--bare');
    const seed = mkTmp();
    initRepo(seed);
    const baseSha = commit(seed, { 'CLAUDE.md': 'fetched base rules' }, 'base');
    commit(seed, { 'CLAUDE.md': 'later' }, 'later');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    git(origin, 'config', 'uploadpack.allowAnySHA1InWant', 'true');

    const parent = mkTmp();
    const clone = path.join(parent, 'clone');
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${origin}`, clone], { stdio: 'pipe' });
    expect(() => git(clone, 'cat-file', '-e', `${baseSha}^{commit}`)).toThrow();

    const { rules, warning } = loadRuleFiles({ repoPath: clone, baseSha });
    expect(rules).toEqual([{ path: 'CLAUDE.md', text: 'fetched base rules' }]);
    expect(warning).toBeNull();
  });
});

describe('loadRuleFiles with an unreachable origin', () => {
  test('returns no rules and the base-commit warning', () => {
    const repo = mkTmp();
    initRepo(repo);
    commit(repo, { 'CLAUDE.md': 'x' }, 'only');
    git(repo, 'remote', 'add', 'origin', path.join(os.tmpdir(), 'sherlock-no-such-origin'));
    const missingSha = 'a'.repeat(40);
    const { rules, warning } = loadRuleFiles({ repoPath: repo, baseSha: missingSha });
    expect(rules).toEqual([]);
    expect(warning).toMatch(/base commit is unavailable/);
  });
});

describe('buildSystemPrompt repo rules', () => {
  test('places rules after the domain-knowledge section', () => {
    const prompt = buildSystemPrompt('', 'DOMAIN', false, 'detective', 'balanced', 'general', 5, 'RULES');
    expect(prompt).toContain('## Repository rules (from the base branch)');
    expect(prompt.indexOf('RULES')).toBeGreaterThan(prompt.indexOf('DOMAIN'));
  });

  test('is unchanged when there are no rules', () => {
    const without = buildSystemPrompt('', 'DOMAIN', false, 'detective', 'balanced', 'general', 5);
    expect(buildSystemPrompt('', 'DOMAIN', false, 'detective', 'balanced', 'general', 5, '')).toBe(without);
    expect(without).not.toContain('Repository rules');
  });
});
