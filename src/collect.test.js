const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { filterDiff, loadRepoConfig } = require('./collect');

const lockBlock = [
  'diff --git a/uv.lock b/uv.lock',
  'index 1111111..2222222 100644',
  '--- a/uv.lock',
  '+++ b/uv.lock',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const codeBlock = [
  'diff --git a/src/app.js b/src/app.js',
  'index 3333333..4444444 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n');

describe('filterDiff', () => {
  test('drops the block of an ignored file and keeps the rest byte-identical', () => {
    expect(filterDiff(lockBlock + codeBlock, ['uv.lock'])).toBe(codeBlock);
    expect(filterDiff(codeBlock + lockBlock, ['uv.lock'])).toBe(codeBlock);
  });

  test('returns the diff unchanged when nothing matches', () => {
    expect(filterDiff(codeBlock, ['uv.lock'])).toBe(codeBlock);
    expect(filterDiff(codeBlock, [])).toBe(codeBlock);
  });

  test('matches a renamed file on its new path only', () => {
    const rename = [
      'diff --git a/uv.lock b/src/keep.js',
      'similarity index 90%',
      'rename from uv.lock',
      'rename to src/keep.js',
      'index 1111111..2222222 100644',
      '--- a/uv.lock',
      '+++ b/src/keep.js',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    expect(filterDiff(rename, ['uv.lock'])).toBe(rename);
    expect(filterDiff(rename, ['src/keep.js'])).toBe('');
  });

  test('matches a pure rename without ---/+++ lines on its new path', () => {
    const pureRename = [
      'diff --git a/old.txt b/package-lock.json',
      'similarity index 100%',
      'rename from old.txt',
      'rename to package-lock.json',
      '',
    ].join('\n');
    expect(filterDiff(pureRename + codeBlock, ['package-lock.json'])).toBe(codeBlock);
    expect(filterDiff(pureRename + codeBlock, ['old.txt'])).toBe(pureRename + codeBlock);
  });

  test('keeps a binary block for a non-ignored file intact and drops an ignored one', () => {
    const binary = [
      'diff --git a/logo.png b/logo.png',
      'index 5555555..6666666 100644',
      'Binary files a/logo.png and b/logo.png differ',
      '',
    ].join('\n');
    expect(filterDiff(lockBlock + binary + codeBlock, ['uv.lock'])).toBe(binary + codeBlock);
    expect(filterDiff(binary + codeBlock, ['*.png'])).toBe(codeBlock);
  });

  test('matches a deleted file on its old path', () => {
    const deleted = [
      'diff --git a/uv.lock b/uv.lock',
      'deleted file mode 100644',
      'index 1111111..0000000',
      '--- a/uv.lock',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
      '',
    ].join('\n');
    expect(filterDiff(deleted + codeBlock, ['uv.lock'])).toBe(codeBlock);
  });

  test('matches a mode-only change on its header path', () => {
    const modeOnly = [
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      '',
    ].join('\n');
    expect(filterDiff(modeOnly + codeBlock, ['run.sh'])).toBe(codeBlock);
  });

  test('returns an empty string when every block is ignored', () => {
    expect(filterDiff(lockBlock, ['uv.lock'])).toBe('');
    expect(filterDiff(lockBlock + codeBlock, ['uv.lock', 'src/*.js'])).toBe('');
  });

  test('does not treat a hunk line that looks like a header as a file boundary', () => {
    const tricky = codeBlock.replace('+b', '+++ b/uv.lock');
    expect(filterDiff(tricky, ['uv.lock'])).toBe(tricky);
  });
});

describe('loadRepoConfig', () => {
  const tmpDirs = [];
  const origWorkspace = process.env.GITHUB_WORKSPACE;
  afterEach(() => {
    process.env.GITHUB_WORKSPACE = origWorkspace;
    if (origWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function mkTmp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherlock-cfg-'));
    tmpDirs.push(dir);
    process.env.GITHUB_WORKSPACE = dir;
    return dir;
  }

  function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  }

  test('reads the base commit version, not the PR version', () => {
    const repo = mkTmp();
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    git(repo, 'config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, '.sherlockqa.yml'), 'max-comments: 3\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'base');
    const baseSha = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, '.sherlockqa.yml'), 'max-comments: 99\n');
    git(repo, 'commit', '-q', '-am', 'pr');
    expect(loadRepoConfig(baseSha)).toEqual({ 'max-comments': 3 });
  });

  test('without .git the working-tree file is read', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, '.sherlockqa.yml'), 'max-comments: 7\n');
    expect(loadRepoConfig('abc123')).toEqual({ 'max-comments': 7 });
  });
});
