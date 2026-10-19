const { filterDiff } = require('./collect');

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
