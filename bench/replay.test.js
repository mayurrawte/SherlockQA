const { isBugFlagged, summarise } = require('./replay');

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
