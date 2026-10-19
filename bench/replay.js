const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { reviewDiff, estimateCost, defaultModelFor, filterAndRouteComments, matchPattern } = require('../src/index');

const IGNORE_PATTERNS = ['*.md', '*.txt', 'package-lock.json', 'yarn.lock'];

function isBugFlagged(findings, fixHunks) {
  return findings.some(finding =>
    fixHunks.some(hunk =>
      hunk.file === finding.file && finding.line >= hunk.start - 5 && finding.line <= hunk.end + 5
    )
  );
}

function parseFixHunks(gitShowText) {
  const hunks = [];
  let file = null;
  for (const line of gitShowText.split('\n')) {
    if (line.startsWith('--- ')) {
      file = line.startsWith('--- a/') ? line.slice(6) : null;
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
    if (hunk && file) {
      const start = parseInt(hunk[1], 10);
      const count = hunk[2] === undefined ? 1 : parseInt(hunk[2], 10);
      hunks.push({ file, start, end: start + Math.max(count, 1) - 1 });
    }
  }
  return hunks;
}

function summarise(results) {
  const summary = { bugsFlagged: 0, bugCases: 0, noiseComments: 0, truncatedCount: 0, costUsd: 0, wallMs: 0 };
  for (const result of results) {
    if (result.kind === 'bug') {
      summary.bugCases += 1;
      if (result.flagged) summary.bugsFlagged += 1;
    } else {
      summary.noiseComments += result.findings.length;
    }
    if (result.truncated) summary.truncatedCount += 1;
    summary.costUsd += result.costUsd || 0;
    summary.wallMs += result.wallMs;
  }
  return summary;
}

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  for (const required of ['repo', 'cases', 'provider', 'label']) {
    if (!args[required]) {
      console.error('Usage: node bench/replay.js --repo <path> --cases <file> --provider <p> --model <m> --label <name> [--region <aws-region>]');
      process.exit(1);
    }
  }
  if (!process.env.SHERLOCK_BENCH_API_KEY && args.provider !== 'ollama') {
    console.error('Set SHERLOCK_BENCH_API_KEY to the provider API key');
    process.exit(1);
  }

  process.env[`INPUT_${args.provider.toUpperCase()}-API-KEY`] = process.env.SHERLOCK_BENCH_API_KEY || '';
  if (args.provider === 'bedrock') {
    process.env['INPUT_AWS-REGION'] = args.region || 'us-east-1';
  }

  const model = args.model || defaultModelFor(args.provider);
  const config = {
    provider: args.provider, model, prAuthor: 'bench', persona: '', domainKnowledge: '', maxTokens: 4096,
    codeQuality: false, personality: 'detective', strictness: 'balanced', mode: 'general', maxComments: 5
  };
  const filter = { minConfidence: 0.6, minSeverity: 'warning', maxComments: config.maxComments };

  const git = (...gitArgs) => execFileSync(
    'git', ['-C', args.repo, '-c', 'core.quotepath=off', ...gitArgs],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const cases = JSON.parse(fs.readFileSync(args.cases, 'utf8'));
  const results = [];
  const errors = [];

  try {
    for (const benchCase of cases) {
      try {
        const range = `${benchCase.base}...${benchCase.head}`;
        const diff = git('diff', '--src-prefix=a/', '--dst-prefix=b/', range);
        const files = git('diff', '--name-only', range)
          .split('\n')
          .filter(name => name && !IGNORE_PATTERNS.some(pattern => matchPattern(name, pattern)))
          .map(name => ({ filename: name }));

        let fixHunks = [];
        if (benchCase.kind === 'bug') {
          fixHunks = parseFixHunks(git('show', '-U0', '--format=', '--src-prefix=a/', '--dst-prefix=b/', benchCase.fixCommit));
          if (fixHunks.length === 0) {
            throw new Error(`fixCommit ${benchCase.fixCommit} produced no hunks`);
          }
        }

        const started = Date.now();
        const { review, usage, truncated, responseTruncated } = await reviewDiff({ diff, files, config });
        const wallMs = Date.now() - started;

        const findings = filterAndRouteComments(review.line_comments || [], filter).inline;
        const result = {
          id: benchCase.id, kind: benchCase.kind, findings, wallMs,
          truncated: Boolean(truncated || responseTruncated),
          costUsd: estimateCost(model, usage)
        };
        if (benchCase.kind === 'bug') {
          result.flagged = isBugFlagged(findings, fixHunks);
        }

        results.push(result);
        console.log(`${benchCase.id} (${benchCase.kind}): ${findings.length} findings${result.flagged ? ', bug flagged' : ''}`);
      } catch (err) {
        errors.push({ id: benchCase.id, error: err.message });
        console.error(`${benchCase.id}: ERROR ${err.message}`);
      }
    }
  } finally {
    const summary = summarise(results);
    const outDir = path.join(__dirname, 'results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `${args.label}.json`), JSON.stringify({
      label: args.label, model, date: new Date().toISOString(), summary, results, errors
    }, null, 2));

    console.log('\nlabel | model | bugs flagged / bug cases | noise comments | truncated | cost USD | wall time | errored');
    console.log(`${args.label} | ${model} | ${summary.bugsFlagged} / ${summary.bugCases} | ${summary.noiseComments} | ${summary.truncatedCount} | ${summary.costUsd.toFixed(4)} | ${(summary.wallMs / 1000).toFixed(1)}s | ${errors.length}`);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { isBugFlagged, parseFixHunks, summarise };
