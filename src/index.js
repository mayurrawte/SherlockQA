const core = require('@actions/core');
const github = require('@actions/github');
const OpenAI = require('openai');

async function run() {
  try {
    // Get inputs
    const githubToken = core.getInput('github-token', { required: true });
    const aiProvider = core.getInput('ai-provider') || 'openai';
    const model = core.getInput('model') || 'gpt-4';
    const minSeverity = core.getInput('min-severity') || 'warning';
    const ignorePatterns = (core.getInput('ignore-patterns') || '').split(',').map(p => p.trim()).filter(Boolean);

    // Validate we're running on a PR
    const context = github.context;
    if (context.eventName !== 'pull_request') {
      core.setFailed('This action only works on pull_request events');
      return;
    }

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = context.repo;
    const prNumber = context.payload.pull_request.number;
    const prAuthor = context.payload.pull_request.user.login;
    const commitSha = context.payload.pull_request.head.sha;

    core.info(`Reviewing PR #${prNumber} by @${prAuthor}`);

    // Get PR diff
    const { data: diff } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' }
    });

    // Get changed files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber
    });

    // Filter ignored files
    const filesToReview = files.filter(file => {
      return !ignorePatterns.some(pattern => matchPattern(file.filename, pattern));
    });

    if (filesToReview.length === 0) {
      core.info('No files to review after filtering');
      return;
    }

    core.info(`Reviewing ${filesToReview.length} files`);

    // Create AI client
    const client = createAIClient(aiProvider);

    // Get review from AI
    const review = await getAIReview(client, model, diff, filesToReview, prAuthor);

    core.info(`Review verdict: ${review.verdict}`);
    core.info(`Found ${review.line_comments?.length || 0} issues`);

    // Parse diff for line positions
    const linePositionMap = parseDiffForLinePositions(diff);

    // Build review comments
    const reviewComments = [];
    const severityLevel = { suggestion: 1, warning: 2, error: 3 };
    const minLevel = severityLevel[minSeverity] || 1;

    for (const comment of (review.line_comments || [])) {
      if (severityLevel[comment.severity] < minLevel) continue;

      const filePositions = linePositionMap[comment.file] || {};
      const position = filePositions[String(comment.line)];

      if (position) {
        const emoji = { error: '🔴', warning: '🟡', suggestion: '🔵' }[comment.severity] || '🔵';
        reviewComments.push({
          path: comment.file,
          position: position,
          body: `${emoji} **${comment.severity.toUpperCase()}**: ${comment.comment}`
        });
      }
    }

    // Build review body
    const body = buildReviewBody(review);

    // Determine review event
    let event = 'COMMENT';
    if (review.verdict === 'approved') {
      event = 'APPROVE';
    } else if (review.verdict === 'do_not_merge') {
      event = 'REQUEST_CHANGES';
    }

    // Submit review
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      body,
      event,
      comments: reviewComments
    });

    core.info('Review posted successfully');

    // Set outputs
    core.setOutput('verdict', review.verdict);
    core.setOutput('summary', review.summary);
    core.setOutput('issues-count', review.line_comments?.length || 0);

    // Fail if verdict is do_not_merge
    if (review.verdict === 'do_not_merge') {
      core.setFailed('Review verdict: Do Not Merge');
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

function createAIClient(provider) {
  if (provider === 'azure') {
    const apiKey = core.getInput('azure-api-key', { required: true });
    const endpoint = core.getInput('azure-endpoint', { required: true });
    const model = core.getInput('azure-model', { required: true });

    return new OpenAI({
      apiKey,
      baseURL: `${endpoint}/openai/deployments/${model}`,
      defaultQuery: { 'api-version': '2024-02-15-preview' },
      defaultHeaders: { 'api-key': apiKey }
    });
  }

  // Default: OpenAI
  const apiKey = core.getInput('openai-api-key', { required: true });
  return new OpenAI({ apiKey });
}

async function getAIReview(client, model, diff, files, prAuthor) {
  const changedFiles = files.map(f => f.filename).join('\n');

  // Truncate diff if too large
  let diffContent = diff;
  if (diff.length > 50000) {
    diffContent = diff.slice(0, 50000) + '\n\n... [diff truncated]';
  }

  const systemPrompt = `You are SherlockQA, an AI code reviewer with two roles:

1. **Senior Software Engineer** - Review code quality, bugs, security
2. **QA Tester** - Think like someone trying to break things. What inputs would crash this? What edge cases are missed?

## Review Focus:
- **Bugs** - Null checks, edge cases, off-by-one errors, division by zero
- **Breaking Changes** - API/schema changes, backward compatibility
- **Security** - Injection, credentials, input validation
- **Test Scenarios** - How can this fail? What would a user try?
- **Orphaned/Incomplete** - Missing pairs (create without delete, open without close, etc.)

## Output Format:
Respond with ONLY a JSON object:
{
  "summary": "One sentence describing what this PR does",
  "line_comments": [
    {"file": "path/to/file.py", "line": 42, "severity": "error|warning|suggestion", "comment": "Issue description"}
  ],
  "tests_required": true|false,
  "test_suggestion": "What tests to write if needed",
  "qa_scenarios": ["Scenario 1", "Scenario 2"],
  "questions": ["Question for author"],
  "verdict": "approved|needs_changes|do_not_merge"
}

Guidelines:
- ONLY comment on actual issues, not style preferences
- Use severity "error" for bugs/security, "warning" for potential problems, "suggestion" for improvements
- Keep comments concise and actionable`;

  const userPrompt = `Review this pull request:

## PR Author: @${prAuthor}

## Changed Files:
${changedFiles}

## Diff:
\`\`\`diff
${diffContent}
\`\`\``;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 4096,
    temperature: 0.3
  });

  const content = response.choices[0].message.content;
  return parseReviewResponse(content);
}

function parseReviewResponse(content) {
  let jsonContent = content.trim();

  // Handle markdown code blocks
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) {
    jsonContent = jsonMatch[1];
  }

  try {
    return JSON.parse(jsonContent);
  } catch (error) {
    core.warning(`Failed to parse AI response: ${error.message}`);
    return {
      summary: 'Unable to parse AI response',
      line_comments: [],
      tests_required: false,
      test_suggestion: '',
      qa_scenarios: [],
      questions: [],
      verdict: 'needs_changes'
    };
  }
}

function parseDiffForLinePositions(diffText) {
  const fileLineMap = {};
  let currentFile = null;
  let diffPosition = 0;
  let currentNewLine = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      fileLineMap[currentFile] = {};
      diffPosition = 0;
      continue;
    }

    if (!currentFile) continue;

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10);
      diffPosition++;
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      fileLineMap[currentFile][currentNewLine] = diffPosition;
      currentNewLine++;
      diffPosition++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      diffPosition++;
    } else if (!line.startsWith('\\')) {
      fileLineMap[currentFile][currentNewLine] = diffPosition;
      currentNewLine++;
      diffPosition++;
    }
  }

  return fileLineMap;
}

function buildReviewBody(review) {
  const parts = [`## 🔍 SherlockQA's Review\n`];

  parts.push(`### Summary\n${review.summary || 'No summary'}\n`);

  if (review.tests_required && review.test_suggestion) {
    parts.push(`### 🧪 Tests Required\n${review.test_suggestion}\n`);
  }

  if (review.qa_scenarios?.length > 0) {
    parts.push(`### 🎯 QA Test Scenarios`);
    review.qa_scenarios.forEach(s => parts.push(`- [ ] ${s}`));
    parts.push('');
  }

  if (review.questions?.length > 0) {
    parts.push(`### ❓ Questions`);
    review.questions.forEach(q => parts.push(`- ${q}`));
    parts.push('');
  }

  const verdictEmoji = { approved: '✅', needs_changes: '⚠️', do_not_merge: '❌' };
  const verdictText = { approved: 'Approved', needs_changes: 'Needs Changes', do_not_merge: 'Do Not Merge' };
  parts.push(`### Verdict\n${verdictEmoji[review.verdict] || '⚠️'} ${verdictText[review.verdict] || review.verdict}`);

  return parts.join('\n');
}

function matchPattern(filename, pattern) {
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern || filename.includes(pattern);
}

run();
