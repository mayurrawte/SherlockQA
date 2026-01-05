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
    const persona = core.getInput('persona') || '';
    const domainKnowledge = core.getInput('domain-knowledge') || '';
    const maxTokens = parseInt(core.getInput('max-tokens') || '4096', 10);

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

    core.info(`Reviewing ${filesToReview.length} files using ${aiProvider}`);

    // Get review from AI
    const review = await getAIReview(aiProvider, model, diff, filesToReview, prAuthor, persona, domainKnowledge, maxTokens);

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
    const body = buildReviewBody(review, prAuthor);

    // Determine review event
    // Note: We use COMMENT instead of APPROVE because GitHub Actions with GITHUB_TOKEN
    // is not permitted to approve pull requests by default (security feature)
    let event = 'COMMENT';
    if (review.verdict === 'do_not_merge') {
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

async function getAIReview(provider, model, diff, files, prAuthor, persona, domainKnowledge, maxTokens) {
  const changedFiles = files.map(f => f.filename).join('\n');

  // Truncate diff if too large
  let diffContent = diff;
  if (diff.length > 50000) {
    diffContent = diff.slice(0, 50000) + '\n\n... [diff truncated]';
  }

  const systemPrompt = buildSystemPrompt(persona, domainKnowledge);
  const userPrompt = buildUserPrompt(changedFiles, diffContent, prAuthor);

  let response;

  if (provider === 'azure-responses') {
    response = await callAzureResponsesAPI(systemPrompt, userPrompt, model, maxTokens);
  } else if (provider === 'azure') {
    response = await callAzureOpenAI(systemPrompt, userPrompt, model, maxTokens);
  } else {
    response = await callOpenAI(systemPrompt, userPrompt, model, maxTokens);
  }

  return parseReviewResponse(response);
}

async function callOpenAI(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('openai-api-key', { required: true });
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  return response.choices[0].message.content;
}

async function callAzureOpenAI(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('azure-api-key', { required: true });
  const endpoint = core.getInput('azure-endpoint', { required: true });
  const deployment = core.getInput('azure-deployment') || model;
  const apiVersion = core.getInput('azure-api-version') || '2024-02-15-preview';

  const client = new OpenAI({
    apiKey,
    baseURL: `${endpoint}/openai/deployments/${deployment}`,
    defaultQuery: { 'api-version': apiVersion },
    defaultHeaders: { 'api-key': apiKey }
  });

  const response = await client.chat.completions.create({
    model: deployment,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  return response.choices[0].message.content;
}

async function callAzureResponsesAPI(systemPrompt, userPrompt, model, maxTokens) {
  const apiKey = core.getInput('azure-api-key', { required: true });
  const endpoint = core.getInput('azure-endpoint', { required: true });
  const apiVersion = core.getInput('azure-api-version') || '2025-04-01-preview';

  // Combine prompts for Responses API format
  const fullPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const url = `${endpoint}/openai/responses?api-version=${apiVersion}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      input: fullPrompt,
      max_output_tokens: maxTokens,
      model: model
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Azure Responses API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();

  // Extract content from Responses API format
  let reviewContent = '';
  if (result.output && Array.isArray(result.output)) {
    for (const item of result.output) {
      if (item.type === 'message' && item.content) {
        for (const contentItem of item.content) {
          if (contentItem.type === 'output_text') {
            reviewContent += contentItem.text || '';
          }
        }
      }
    }
  }

  if (!reviewContent) {
    throw new Error(`Unable to parse Azure Responses API response: ${JSON.stringify(result).slice(0, 500)}`);
  }

  return reviewContent;
}

function buildSystemPrompt(persona, domainKnowledge) {
  let prompt = '';

  // Add persona if provided
  if (persona) {
    prompt += `${persona}\n\n`;
  }

  prompt += `You are SherlockQA, an AI code reviewer with two roles:

1. **Senior Software Engineer** - Review code quality, bugs, security
2. **QA Tester** - Think like someone trying to break things. What inputs would crash this? What edge cases are missed?`;

  // Add domain knowledge if provided
  if (domainKnowledge) {
    prompt += `

## Domain Knowledge
${domainKnowledge}`;
  }

  prompt += `

## Review Focus:
- **Bugs** - Null checks, edge cases, off-by-one errors, division by zero
- **Breaking Changes** - API/schema changes, backward compatibility
- **Security** - Injection, credentials, input validation
- **Test Scenarios** - How can this fail? What would a user try?
- **Orphaned/Incomplete** - Missing pairs (create without delete, open without close, etc.)

## Output Format:
You MUST respond with a JSON object in this exact format:
\`\`\`json
{
  "summary": "One sentence describing what this PR does",
  "line_comments": [
    {"file": "path/to/file.py", "line": 42, "severity": "error|warning|suggestion", "comment": "Issue description"}
  ],
  "tests_required": true|false,
  "test_suggestion": "If tests_required is true, explain what tests to write",
  "qa_scenarios": ["Scenario 1", "Scenario 2"],
  "questions": ["Question for author"],
  "verdict": "approved|needs_changes|do_not_merge"
}
\`\`\`

## Guidelines:
- ONLY comment on actual issues, not style preferences
- Use severity "error" for bugs/security, "warning" for potential problems, "suggestion" for improvements
- Set tests_required to true only for new business logic without coverage
- Keep comments concise and actionable`;

  return prompt;
}

function buildUserPrompt(changedFiles, diffContent, prAuthor) {
  return `Please review the following pull request changes:

## PR Author: @${prAuthor}

## Changed Files:
${changedFiles}

## Diff:
\`\`\`diff
${diffContent}
\`\`\`

Respond with ONLY the JSON object as specified. No additional text.`;
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
    core.warning(`Raw response: ${content.slice(0, 500)}`);
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

function buildReviewBody(review, prAuthor) {
  const parts = [`## 🔍 SherlockQA's Review\n`];

  parts.push(`### 📝 Summary\n${review.summary || 'No summary'}\n`);

  if (review.tests_required && review.test_suggestion) {
    parts.push(`### 🧪 Tests Required`);
    parts.push(`⚠️ **@${prAuthor}** - Please add test cases for this change:\n`);
    parts.push(`${review.test_suggestion}\n`);
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
  parts.push(`### 🏁 Verdict\n${verdictEmoji[review.verdict] || '⚠️'} ${verdictText[review.verdict] || review.verdict}`);

  return parts.join('\n');
}

function matchPattern(filename, pattern) {
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern || filename.includes(pattern);
}

run();
