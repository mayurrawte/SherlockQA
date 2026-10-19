const { isBugFlagged, parseFixHunks, summarise } = require('./replay');

describe('isBugFlagged', () => {
  const fixHunks = [{ file: 'a.py', start: 15, end: 15 }];

  test('flags a finding within 5 lines of a fixed line on the same file', () => {
    expect(isBugFlagged([{ file: 'a.py', line: 12 }], fixHunks)).toBe(true);
  });

  test('ignores a finding further than 5 lines away', () => {
    expect(isBugFlagged([{ file: 'a.py', line: 30 }], fixHunks)).toBe(false);
  });

  test('ignores a finding on another file', () => {
    expect(isBugFlagged([{ file: 'b.py', line: 15 }], fixHunks)).toBe(false);
  });

  test('uses the whole range of a multi-line hunk', () => {
    expect(isBugFlagged([{ file: 'a.py', line: 24 }], [{ file: 'a.py', start: 10, end: 20 }])).toBe(true);
    expect(isBugFlagged([{ file: 'a.py', line: 26 }], [{ file: 'a.py', start: 10, end: 20 }])).toBe(false);
  });
});

describe('summarise', () => {
  test('counts noise on clean cases only and sums cost and wall time', () => {
    const results = [
      { kind: 'bug', flagged: true, findings: [{}, {}], truncated: false, costUsd: 0.5, wallMs: 1000 },
      { kind: 'bug', flagged: false, findings: [{}], truncated: true, costUsd: 0.25, wallMs: 2000 },
      { kind: 'clean', findings: [{}, {}, {}], truncated: false, costUsd: 0.25, wallMs: 500 },
      { kind: 'clean', findings: [], truncated: true, costUsd: null, wallMs: 500 }
    ];
    expect(summarise(results)).toEqual({
      bugsFlagged: 1, bugCases: 2, noiseComments: 3, truncatedCount: 2, costUsd: 1, wallMs: 4000
    });
  });
});

describe('parseFixHunks', () => {
  test('reads the old-side range of a normal hunk', () => {
    const text = 'diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -15,2 +15,3 @@ def f():\n-x\n';
    expect(parseFixHunks(text)).toEqual([{ file: 'a.py', start: 15, end: 16 }]);
  });

  test('treats a missing count as one line', () => {
    const text = '--- a/a.py\n+++ b/a.py\n@@ -10 +10 @@\n';
    expect(parseFixHunks(text)).toEqual([{ file: 'a.py', start: 10, end: 10 }]);
  });

  test('uses the insertion point for a pure addition', () => {
    const text = '--- a/a.py\n+++ b/a.py\n@@ -20,0 +21,2 @@\n';
    expect(parseFixHunks(text)).toEqual([{ file: 'a.py', start: 20, end: 20 }]);
  });

  test('keeps the old range of a pure deletion', () => {
    const text = '--- a/a.py\n+++ b/a.py\n@@ -12,3 +11,0 @@\n';
    expect(parseFixHunks(text)).toEqual([{ file: 'a.py', start: 12, end: 14 }]);
  });

  test('keeps a file deleted to /dev/null', () => {
    const text = '--- a/old.py\n+++ /dev/null\n@@ -1,4 +0,0 @@\n';
    expect(parseFixHunks(text)).toEqual([{ file: 'old.py', start: 1, end: 4 }]);
  });

  test('skips a newly added file and reads several files', () => {
    const text = '--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,5 @@\n--- a/a.py\n+++ b/a.py\n@@ -3 +3 @@\n--- a/b.py\n+++ b/b.py\n@@ -7,2 +7,2 @@\n';
    expect(parseFixHunks(text)).toEqual([
      { file: 'a.py', start: 3, end: 3 },
      { file: 'b.py', start: 7, end: 8 }
    ]);
  });
});
