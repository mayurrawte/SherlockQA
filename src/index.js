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
    const autoApprove = core.getInput('auto-approve') === 'true';
    const codeQuality = core.getInput('code-quality') === 'true';

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

    // Find and dismiss previous SherlockQA review, preserving checked scenarios
    const previousCheckedScenarios = await findAndDismissPreviousReview(octokit, owner, repo, prNumber);

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
    const review = await getAIReview(aiProvider, model, diff, filesToReview, prAuthor, persona, domainKnowledge, maxTokens, codeQuality);

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

    // Build review body (preserving previously checked scenarios)
    const body = buildReviewBody(review, prAuthor, previousCheckedScenarios);

    // Determine review event
    let event = 'COMMENT';
    if (review.verdict === 'approved' && autoApprove) {
      // Note: Approving PRs requires either a PAT or enabling "Allow GitHub Actions to approve pull requests"
      // in repository settings under Actions > General > Workflow permissions
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

async function findAndDismissPreviousReview(octokit, owner, repo, prNumber) {
  const checkedScenarios = new Set();

  try {
    // Get all reviews on the PR
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber
    });

    // Find SherlockQA reviews (identified by the header)
    const sherlockReviews = reviews.filter(review =>
      review.body && review.body.includes("## 🔍 SherlockQA's Review")
    );

    for (const review of sherlockReviews) {
      // Parse checked scenarios from the review body
      const checkedMatches = review.body.matchAll(/- \[x\] (.+)/gi);
      for (const match of checkedMatches) {
        checkedScenarios.add(match[1].trim());
      }

      // Dismiss the previous review to collapse it
      try {
        await octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id,
          message: '🔄 Updated review available below (PR was updated)'
        });
        core.info(`Dismissed previous SherlockQA review #${review.id}`);
      } catch (dismissError) {
        // Dismissal may fail if review is not in a dismissable state (e.g., COMMENTED)
        // In that case, we just continue - the old review will remain but new one will be added
        core.info(`Could not dismiss review #${review.id}: ${dismissError.message}`);
      }
    }
  } catch (error) {
    core.warning(`Failed to check for previous reviews: ${error.message}`);
  }

  return checkedScenarios;
}

async function getAIReview(provider, model, diff, files, prAuthor, persona, domainKnowledge, maxTokens, codeQuality) {
  const changedFiles = files.map(f => f.filename).join('\n');

  // Truncate diff if too large
  let diffContent = diff;
  if (diff.length > 50000) {
    diffContent = diff.slice(0, 50000) + '\n\n... [diff truncated]';
  }

  const systemPrompt = buildSystemPrompt(persona, domainKnowledge, codeQuality);
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

function buildSystemPrompt(persona, domainKnowledge, codeQuality) {
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
- **Orphaned/Incomplete** - Missing pairs (create without delete, open without close, etc.)`;

  // Add code quality focus if enabled
  if (codeQuality) {
    prompt += `
- **Code Quality** - Analyze for repetitive/duplicated code, code smells, maintainability issues, overly complex functions`;
  }

  prompt += `

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
  "questions": ["Question for author"],`;

  // Add code quality to output format if enabled
  if (codeQuality) {
    prompt += `
  "code_quality": {
    "summary": "Brief assessment of code quality",
    "issues": ["List of code quality issues like repetitive code, complex functions, etc."]
  },`;
  }

  prompt += `
  "verdict": "approved|needs_changes|do_not_merge"
}
\`\`\`

## Guidelines:
- ONLY comment on actual issues, not style preferences
- Use severity "error" for bugs/security, "warning" for potential problems, "suggestion" for improvements
- **tests_required**: Set to true ONLY when the change introduces significant new business logic, complex algorithms, or critical functionality that genuinely needs test coverage. Do NOT require tests for: simple refactors, config changes, minor bug fixes, documentation, or straightforward CRUD operations. Be pragmatic - not every change needs tests.
- Keep comments concise and actionable`;

  if (codeQuality) {
    prompt += `
- For code_quality, identify repetitive patterns, duplicated logic, overly complex functions (high cyclomatic complexity), and maintainability concerns`;
  }

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

function buildReviewBody(review, prAuthor, previousCheckedScenarios = new Set()) {
  const parts = [`## 🔍 SherlockQA's Review\n`];

  parts.push(`### 📝 Summary\n${review.summary || 'No summary'}\n`);

  if (review.tests_required && review.test_suggestion) {
    parts.push(`### 🧪 Tests Required`);
    parts.push(`⚠️ **@${prAuthor}** - Please add test cases for this change:\n`);
    parts.push(`${review.test_suggestion}\n`);
  }

  if (review.qa_scenarios?.length > 0) {
    parts.push(`### 🎯 QA Test Scenarios`);
    review.qa_scenarios.forEach(scenario => {
      // Check if this scenario (or a similar one) was previously checked
      const isChecked = isScenarioPreviouslyChecked(scenario, previousCheckedScenarios);
      const checkbox = isChecked ? '[x]' : '[ ]';
      parts.push(`- ${checkbox} ${scenario}`);
    });
    parts.push('');
  }

  if (review.questions?.length > 0) {
    parts.push(`### ❓ Questions`);
    review.questions.forEach(q => parts.push(`- ${q}`));
    parts.push('');
  }

  // Add code quality section if present
  if (review.code_quality) {
    parts.push(`### 🧹 Code Quality`);
    if (review.code_quality.summary) {
      parts.push(`${review.code_quality.summary}\n`);
    }
    if (review.code_quality.issues?.length > 0) {
      review.code_quality.issues.forEach(issue => parts.push(`- ${issue}`));
      parts.push('');
    }
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

function isScenarioPreviouslyChecked(scenario, previousCheckedScenarios) {
  // Normalize the scenario text for comparison
  const normalize = (text) => text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const normalizedScenario = normalize(scenario);

  for (const checked of previousCheckedScenarios) {
    const normalizedChecked = normalize(checked);
    // Exact match
    if (normalizedScenario === normalizedChecked) {
      return true;
    }
    // Fuzzy match - if one contains most of the other (for slight wording changes)
    if (normalizedScenario.includes(normalizedChecked) || normalizedChecked.includes(normalizedScenario)) {
      return true;
    }
    // Check word overlap (if >70% of words match)
    const scenarioWords = new Set(normalizedScenario.split(/\s+/));
    const checkedWords = new Set(normalizedChecked.split(/\s+/));
    const intersection = [...scenarioWords].filter(w => checkedWords.has(w));
    const minSize = Math.min(scenarioWords.size, checkedWords.size);
    if (minSize > 0 && intersection.length / minSize >= 0.7) {
      return true;
    }
  }
  return false;
}

run();
