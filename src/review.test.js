const { splitDiffByFile, groupFileDiffs } = require('./collect');
const { reviewDiff, mergeReviews } = require('./review');
const { parseDiffForLinePositions } = require('./index');

function fileDiff(file, bodyChars) {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,2 @@\n context\n+${'x'.repeat(bodyChars)}\n`;
}

function bigFileDiff(file, hunks, hunkChars) {
  let text = `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`;
  for (let i = 0; i < hunks; i++) {
    text += `@@ -${i * 10 + 1},1 +${i * 10 + 1},2 @@\n context\n+${'y'.repeat(hunkChars)}\n`;
  }
  return text;
}

const THREE_FILES = fileDiff('src/a.js', 40000) + fileDiff('src/b.js', 40000) + fileDiff('lib/c.js', 40000);

describe('splitDiffByFile and groupFileDiffs', () => {
  test('splits a diff into one entry per file', () => {
    const parts = splitDiffByFile(THREE_FILES);
    expect(parts.map(p => p.file)).toEqual(['src/a.js', 'src/b.js', 'lib/c.js']);
    expect(parts.map(p => p.text).join('')).toBe(THREE_FILES);
  });

  test('a 120,000 char three-file diff yields at least 3 groups, none over 50,000', () => {
    const groups = groupFileDiffs(splitDiffByFile(THREE_FILES), 50000);
    expect(groups.length).toBeGreaterThanOrEqual(3);
    for (const g of groups) {
      expect(g.map(f => f.text).join('').length).toBeLessThanOrEqual(50000);
    }
  });

  test('files in the same directory are packed together before other directories', () => {
    const diff = fileDiff('src/a.js', 100) + fileDiff('lib/c.js', 100) + fileDiff('src/b.js', 100);
    const groups = groupFileDiffs(splitDiffByFile(diff), 50000);
    expect(groups).toHaveLength(1);
    expect(groups[0].map(f => f.file)).toEqual(['lib/c.js', 'src/a.js', 'src/b.js']);
  });

  test('within a directory larger files come first', () => {
    const diff = fileDiff('src/small.js', 100) + fileDiff('src/big.js', 5000);
    const groups = groupFileDiffs(splitDiffByFile(diff), 50000);
    expect(groups[0].map(f => f.file)).toEqual(['src/big.js', 'src/small.js']);
  });

  test('a single 80,000 char file splits only at @@ lines', () => {
    const diff = bigFileDiff('big.js', 8, 10000);
    expect(diff.length).toBeGreaterThan(80000);
    const groups = groupFileDiffs(splitDiffByFile(diff), 50000);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const g of groups) {
      const text = g.map(f => f.text).join('');
      expect(text.length).toBeLessThanOrEqual(50000);
      expect(g.every(f => f.file === 'big.js')).toBe(true);
      expect(text.startsWith('diff --git a/big.js b/big.js\n')).toBe(true);
      const afterHeader = text.split('\n').slice(3);
      expect(afterHeader[0].startsWith('@@')).toBe(true);
    }
    const hunks = groups.map(g => g.map(f => f.text).join('')).join('').match(/^@@ /gm);
    expect(hunks).toHaveLength(8);
  });
});

describe('mergeReviews', () => {
  const base = { summary: 's', line_comments: [], qa_scenarios: [], questions: [], tests_required: false, test_suggestion: '' };

  test('a single review is returned unchanged', () => {
    const r = { ...base, verdict: 'approved' };
    expect(mergeReviews([r])).toBe(r);
  });

  test('picks the worst verdict and concatenates comments and summaries', () => {
    const a = { ...base, summary: 'first', verdict: 'approved', line_comments: [{ file: 'a.js', line: 1 }] };
    const b = { ...base, summary: 'second', verdict: 'do_not_merge', line_comments: [{ file: 'b.js', line: 2 }], verdict_reason: 'bad' };
    const c = { ...base, summary: 'third', verdict: 'needs_changes' };
    const m = mergeReviews([a, b, c]);
    expect(m.verdict).toBe('do_not_merge');
    expect(m.verdict_reason).toBe('bad');
    expect(m.line_comments.map(l => l.file)).toEqual(['a.js', 'b.js']);
    expect(m.summary).toBe('first second third');
  });

  test('caps merged qa_scenarios at 5', () => {
    const a = { ...base, verdict: 'approved', qa_scenarios: ['1', '2', '3', '4'] };
    const b = { ...base, verdict: 'approved', qa_scenarios: ['5', '6', '7'] };
    expect(mergeReviews([a, b]).qa_scenarios).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('reviewDiff in groups', () => {
  const origFetch = global.fetch;
  const config = { provider: 'anthropic', model: 'claude-sonnet-4-5', maxTokens: 4096, strictness: 'balanced', mode: 'standard', maxComments: 10 };
  const files = [{ filename: 'src/a.js' }, { filename: 'src/b.js' }, { filename: 'lib/c.js' }];
  beforeEach(() => { process.env['INPUT_ANTHROPIC-API-KEY'] = 'test-key'; });
  afterEach(() => { global.fetch = origFetch; delete process.env['INPUT_ANTHROPIC-API-KEY']; });

  function okResponse(review) {
    return {
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(review).slice(1) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      })
    };
  }

  test('calls the provider once per group and never adds [diff truncated]', async () => {
    global.fetch = jest.fn().mockResolvedValue(okResponse({ summary: 'ok', verdict: 'approved', line_comments: [] }));
    const r = await reviewDiff({ diff: THREE_FILES, files, config });
    expect(r.truncated).toBe(false);
    expect(r.failedFiles).toEqual([]);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    for (const call of global.fetch.mock.calls) {
      expect(call[1].body).not.toContain('[diff truncated]');
    }
    expect(r.usage).toEqual({ input: 30, output: 15 });
  });

  test('a small diff makes one call and returns its review unchanged', async () => {
    const review = { summary: 'ok', verdict: 'approved', line_comments: [] };
    global.fetch = jest.fn().mockResolvedValue(okResponse(review));
    const r = await reviewDiff({ diff: fileDiff('src/a.js', 100), files, config });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(r.review).toEqual(review);
  });

  test('a group that fails puts its files in failedFiles and keeps the other findings', async () => {
    const finding = { file: 'src/a.js', line: 2, severity: 'error', comment: 'bug' };
    global.fetch = jest.fn().mockImplementation(async (url, opts) => {
      if (opts.body.includes('lib/c.js')) {
        const e = new Error('bad request');
        e.status = 400;
        throw e;
      }
      return okResponse({ summary: 'ok', verdict: 'needs_changes', line_comments: [finding] });
    });
    const r = await reviewDiff({ diff: THREE_FILES, files, config });
    expect(r.failedFiles).toEqual(['lib/c.js']);
    expect(r.review.line_comments).toHaveLength(2);
    expect(r.review.verdict).toBe('needs_changes');
  });

  test('a failed group downgrades an approved merge to needs_changes', async () => {
    global.fetch = jest.fn().mockImplementation(async (url, opts) => {
      if (opts.body.includes('lib/c.js')) {
        const e = new Error('bad request');
        e.status = 400;
        throw e;
      }
      return okResponse({ summary: 'ok', verdict: 'approved', line_comments: [] });
    });
    const r = await reviewDiff({ diff: THREE_FILES, files, config });
    expect(r.failedFiles).toEqual(['lib/c.js']);
    expect(r.review.verdict).toBe('needs_changes');
  });

  test('rethrows when every group fails', async () => {
    global.fetch = jest.fn().mockImplementation(async () => {
      const e = new Error('bad request');
      e.status = 400;
      throw e;
    });
    await expect(reviewDiff({ diff: THREE_FILES, files, config })).rejects.toThrow('bad request');
  });

  test('positions come from the unfiltered diff, so a finding in a later group maps to its original position', () => {
    const groups = groupFileDiffs(splitDiffByFile(THREE_FILES), 50000);
    expect(groups[0].map(f => f.file)).toEqual(['lib/c.js']);
    expect(groups[2].map(f => f.file)).toEqual(['src/b.js']);
    const map = parseDiffForLinePositions(THREE_FILES);
    expect(map['src/b.js']['2']).toBe(2);
    expect(map['src/a.js']['2']).toBe(2);
  });
});

describe('buildReviewBody failed files banner', () => {
  const { buildReviewBody } = require('./publish');
  const review = { summary: 's', verdict: 'needs_changes', line_comments: [], qa_scenarios: [], questions: [] };

  test('names failed files in place of the truncation banner', () => {
    for (const style of ['compact', 'detailed']) {
      const body = buildReviewBody(review, 'dev', new Set(), style, false, true, null, false, [], ['lib/c.js', 'src/b.js']);
      expect(body).toContain('lib/c.js, src/b.js');
      expect(body).not.toMatch(/got truncated/);
    }
  });

  test('no banner when nothing failed', () => {
    const body = buildReviewBody(review, 'dev', new Set(), 'compact', false);
    expect(body).not.toContain('failed for');
  });
});
