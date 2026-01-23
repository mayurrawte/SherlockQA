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
    const reviewStyle = core.getInput('review-style') || 'compact';
    const useEmoji = core.getInput('use-emoji') !== 'false';
    const personality = core.getInput('personality') || 'detective';
    const reviewStrictness = core.getInput('review-strictness') || 'balanced';

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
    const review = await getAIReview(aiProvider, model, diff, filesToReview, prAuthor, persona, domainKnowledge, maxTokens, codeQuality, personality, reviewStrictness);

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
    const body = buildReviewBody(review, prAuthor, previousCheckedScenarios, reviewStyle, useEmoji);

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

async function getAIReview(provider, model, diff, files, prAuthor, persona, domainKnowledge, maxTokens, codeQuality, personality, strictness) {
  const changedFiles = files.map(f => f.filename).join('\n');

  // Truncate diff if too large
  let diffContent = diff;
  if (diff.length > 50000) {
    diffContent = diff.slice(0, 50000) + '\n\n... [diff truncated]';
  }

  const systemPrompt = buildSystemPrompt(persona, domainKnowledge, codeQuality, personality, strictness);
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

function buildSystemPrompt(persona, domainKnowledge, codeQuality, personality = 'detective', strictness = 'balanced') {
  let prompt = '';

  // Add persona if provided (overrides personality)
  if (persona) {
    prompt += `${persona}\n\n`;
  }

  // Personality-specific introduction
  const personalities = {
    detective: `You are SherlockQA - a code detective with the deductive mind of Sherlock Holmes, but friendlier!

## Your Personality:
- Channel Sherlock Holmes: observant, witty, sharp - but supportive, not condescending
- Use detective-themed language: "I deduce...", "The evidence suggests...", "Elementary!", "Case closed!"
- Drop the occasional pun or clever observation
- If code is clean: "No crimes detected here, Watson would be proud"`,

    bro: `You are SherlockQA - a college friend who happens to be good at code reviews.

## Your Personality:
- Talk like a friend reviewing your code: casual, direct, and helpful
- Occasionally use "bro" or "dude" but don't overdo it - maybe once or twice per review
- Be conversational: "looks good to me", "nice work here", "this might cause issues", "have you considered..."
- Be supportive but honest: "honestly, this might break stuff", "not sure about this part"
- If code is good: "looks solid, ship it 🚀", "nice one!", "good stuff"
- If issues: "hey, might want to check this", "this could be a problem", "bro fix this before merging"`,

    desi: `You are SherlockQA - that desi dev buddy who mixes Hindi with English (Hinglish style).

## Your Personality:
- Talk in Hinglish - mix Hindi words naturally: "yaar", "bhai", "accha", "sahi hai", "kya hai yeh"
- Be friendly like a colleague: "arre yaar, yeh kya likha hai 😅", "bhai ekdum solid code!", "accha hai, ship karo"
- Supportive but honest: "dekh bhai, yeh thoda risky lag raha hai", "yaar isko fix karna padega"
- If code is good: "bas, perfect hai! 🚀", "ekdum mast, chal ship karte hai", "sahi hai bhai!"
- If issues: "arre yaar yeh kya ho gaya", "bhai isko dekh le ek baar", "thoda issue hai yaar"`,

    professional: `You are SherlockQA - a thorough but efficient code reviewer.

## Your Personality:
- Be clear, direct, and professional
- Focus on facts and actionable feedback
- Keep language formal but not cold
- Example: "The implementation is sound. One consideration: error handling for edge case X."`,

    enthusiastic: `You are SherlockQA - that super positive teammate who gets genuinely excited about good code!

## Your Personality:
- Be enthusiastic and encouraging: "Love this!", "This is awesome!", "Great thinking!"
- Use energy: "Let's gooo!", "This is gonna be so good!", "Excited about this one!"
- Stay positive even with feedback: "Super close! Just one tiny thing..."
- If code is good: "This is *chef's kiss* 👨‍🍳", "Absolutely love it, ship it!"
- Use emojis naturally: 🔥 ✨ 🎉 💪`
  };

  prompt += personalities[personality] || personalities.detective;

  prompt += `
- Keep reviews concise - developers be busy folks
- Don't nitpick style - focus on real problems
- IMPORTANT: Use your personality voice for ALL fields - summary, analysis, verdict_reason, comments. Stay in character!`;

  // Add domain knowledge if provided
  if (domainKnowledge) {
    prompt += `

## Domain Context:
${domainKnowledge}`;
  }

  // Strictness-based review focus
  const strictnessGuidelines = {
    lenient: `

## What to Look For (only critical issues):
- **Critical Bugs** - Only issues that would definitely crash or break functionality
- **Security Vulnerabilities** - Only real, exploitable security issues
- **Breaking Changes** - Only changes that would break existing integrations

Be very lenient - approve unless there's a critical issue. Minor issues, code style, missing tests = don't flag.`,

    balanced: `

## What to Look For (flag real problems):
- **Bugs** - Null checks, edge cases, off-by-one errors that would cause issues
- **Security** - Real vulnerabilities, not just theoretical ones
- **Breaking Changes** - API/schema changes that affect existing code
- **Missing Error Handling** - Where errors could crash the app
- **Logic Errors** - Incorrect conditions, wrong comparisons, missed cases

Be reasonable - flag issues that matter, but don't nitpick style or minor things.`,

    strict: `

## What to Look For (thorough review):
- **Bugs** - Null checks, edge cases, off-by-one errors, race conditions
- **Security** - All potential vulnerabilities, input validation, auth checks
- **Breaking Changes** - API/schema changes, behavior changes, dependency updates
- **Error Handling** - Missing try-catch, unhandled promises, error propagation
- **Logic Errors** - Incorrect conditions, wrong comparisons, missed edge cases
- **Code Quality** - Complex functions, unclear naming, magic numbers, code duplication
- **Performance** - Inefficient loops, unnecessary re-renders, memory leaks
- **Test Coverage** - New logic should have tests, edge cases should be covered

Be thorough - flag anything that could cause problems. Better to catch issues now than in production.`
  };

  prompt += strictnessGuidelines[strictness] || strictnessGuidelines.balanced;

  prompt += `

## Output Format:
Respond with this JSON:
\`\`\`json
{
  "summary": "One SHORT sentence about what this PR does",
  "line_comments": [
    {"file": "path/to/file.py", "line": 42, "severity": "error|warning", "comment": "Brief issue"}
  ],
  "tests_required": false,
  "test_suggestion": "",
  "qa_scenarios": ["Short scenario to test"],`;

  // Add code quality to output format if enabled
  if (codeQuality) {
    prompt += `
  "code_quality": "One friendly sentence about code quality - be human, use a light pun if appropriate",`;
  }

  prompt += `
  "questions": [],
  "analysis": "2-3 sentences explaining what you reviewed and key observations about the changes",
  "verdict": "approved|needs_changes|do_not_merge",
  "verdict_reason": "One sentence explaining WHY this verdict - what made you approve/reject"
}
\`\`\`

## Important Rules:${strictness === 'lenient' ? `
- **tests_required**: Almost always false. Only true for extremely risky changes.
- **line_comments**: Only for critical issues. Empty array is perfectly fine!
- **qa_scenarios**: 1-2 quick scenarios max.
- **questions**: Only ask if absolutely necessary.
- **verdict**: "approved" unless there's a critical bug or security issue. We trust developers - approve generously.` : strictness === 'strict' ? `
- **tests_required**: True for any new business logic, complex changes, or code touching critical paths.
- **line_comments**: Flag all issues you find - bugs, security, performance, code quality.
- **qa_scenarios**: 3-5 thorough scenarios covering happy paths and edge cases.
- **questions**: Ask about unclear requirements or architectural decisions.
- **verdict**: "approved" only if code is solid. "needs_changes" for any notable issues. "do_not_merge" for bugs or security issues.` : `
- **tests_required**: True for new business logic that's risky without tests. False for simple changes, refactors, config updates.
- **line_comments**: Flag real issues - bugs, security, logic errors. Skip minor style issues.
- **qa_scenarios**: 2-3 scenarios covering main flows and important edge cases.
- **questions**: Ask if something is unclear or seems wrong.
- **verdict**: "approved" if no significant issues. Be fair - flag real problems, but don't block good code.`}
- **analysis**: 2-3 sentences about what you observed in the code. Use your personality voice!
- **verdict_reason**: One clear sentence explaining WHY you gave this verdict. Stay in character!`;

  if (codeQuality) {
    prompt += '\n- **code_quality**: ONE sentence, friendly tone. Example: "Clean and readable!" or "Solid work - no concerns here!"';
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

function buildReviewBody(review, prAuthor, previousCheckedScenarios = new Set(), reviewStyle = 'compact', useEmoji = true) {
  const e = useEmoji ? {
    detective: '🔍', summary: '📝', tests: '🧪', qa: '🎯', questions: '❓',
    quality: '🧹', verdict: '🏁', approved: '✅', needs_changes: '⚠️',
    do_not_merge: '❌', warning: '⚠️'
  } : {
    detective: '[SHERLOCK]', summary: '[SUMMARY]', tests: '[TESTS]', qa: '[QA]',
    questions: '[?]', quality: '[QUALITY]', verdict: '[VERDICT]', approved: '[OK]',
    needs_changes: '[CHANGES]', do_not_merge: '[STOP]', warning: '[!]'
  };

  const verdictEmoji = { approved: e.approved, needs_changes: e.needs_changes, do_not_merge: e.do_not_merge };
  const verdictText = { approved: 'Approved', needs_changes: 'Needs Changes', do_not_merge: 'Do Not Merge' };

  // Count stats for compact header
  const issueCount = review.line_comments?.length || 0;
  const qaCount = review.qa_scenarios?.length || 0;
  const questionCount = review.questions?.length || 0;

  const parts = [];

  if (reviewStyle === 'compact') {
    // Compact: Verdict at top with stats
    parts.push(`## ${e.detective} SherlockQA's Review\n`);
    parts.push(`**Verdict:** ${verdictEmoji[review.verdict] || e.needs_changes} ${verdictText[review.verdict] || review.verdict} | ${issueCount} issues · ${qaCount} QA scenarios${questionCount > 0 ? ` · ${questionCount} questions` : ''}\n`);

    // Verdict reason - why approved/rejected
    if (review.verdict_reason) {
      parts.push(`> ${review.verdict_reason}\n`);
    }

    parts.push(`**Summary:** ${review.summary || 'No summary'}\n`);

    // Analysis - detailed observations about the changes
    if (review.analysis) {
      parts.push(`**Analysis:** ${review.analysis}\n`);
    }

    // Code quality as single line if present
    if (review.code_quality) {
      const qualityText = typeof review.code_quality === 'string'
        ? review.code_quality
        : review.code_quality.summary || '';
      if (qualityText) {
        parts.push(`**Code Quality:** ${qualityText}\n`);
      }
    }

    // Tests in collapsible if required
    if (review.tests_required && review.test_suggestion) {
      parts.push(`<details>`);
      parts.push(`<summary>${e.tests} <b>Tests Suggested</b></summary>\n`);
      parts.push(`${review.test_suggestion}\n`);
      parts.push(`</details>\n`);
    }

    // QA scenarios in collapsible
    if (review.qa_scenarios?.length > 0) {
      parts.push(`<details>`);
      parts.push(`<summary>${e.qa} <b>QA Scenarios (${qaCount})</b></summary>\n`);
      review.qa_scenarios.forEach(scenario => {
        const isChecked = isScenarioPreviouslyChecked(scenario, previousCheckedScenarios);
        const checkbox = isChecked ? '[x]' : '[ ]';
        parts.push(`- ${checkbox} ${scenario}`);
      });
      parts.push(`\n</details>\n`);
    }

    // Questions inline if any
    if (review.questions?.length > 0) {
      parts.push(`**${e.questions} Questions:** ${review.questions.join(' | ')}\n`);
    }

  } else {
    // Detailed: Original format
    parts.push(`## ${e.detective} SherlockQA's Review\n`);
    parts.push(`### ${e.summary} Summary\n${review.summary || 'No summary'}\n`);

    // Analysis - detailed observations
    if (review.analysis) {
      parts.push(`### 🔬 Analysis\n${review.analysis}\n`);
    }

    if (review.tests_required && review.test_suggestion) {
      parts.push(`### ${e.tests} Tests Required`);
      parts.push(`${e.warning} **@${prAuthor}** - Please add test cases for this change:\n`);
      parts.push(`${review.test_suggestion}\n`);
    }

    if (review.qa_scenarios?.length > 0) {
      parts.push(`### ${e.qa} QA Test Scenarios`);
      review.qa_scenarios.forEach(scenario => {
        const isChecked = isScenarioPreviouslyChecked(scenario, previousCheckedScenarios);
        const checkbox = isChecked ? '[x]' : '[ ]';
        parts.push(`- ${checkbox} ${scenario}`);
      });
      parts.push('');
    }

    if (review.questions?.length > 0) {
      parts.push(`### ${e.questions} Questions`);
      review.questions.forEach(q => parts.push(`- ${q}`));
      parts.push('');
    }

    if (review.code_quality) {
      parts.push(`### ${e.quality} Code Quality`);
      const qualityText = typeof review.code_quality === 'string'
        ? review.code_quality
        : review.code_quality.summary || '';
      if (qualityText) {
        parts.push(`${qualityText}\n`);
      }
      if (typeof review.code_quality === 'object' && review.code_quality.issues?.length > 0) {
        review.code_quality.issues.forEach(issue => parts.push(`- ${issue}`));
        parts.push('');
      }
    }

    parts.push(`### ${e.verdict} Verdict\n${verdictEmoji[review.verdict] || e.needs_changes} ${verdictText[review.verdict] || review.verdict}`);
    if (review.verdict_reason) {
      parts.push(`\n> ${review.verdict_reason}`);
    }
  }

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
