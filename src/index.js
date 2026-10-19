const core = require('@actions/core');
const github = require('@actions/github');
const { SEVERITY_EMOJI, normalizeSeverity, normalizeConfidence, filterAndRouteComments, parseReviewResponse, countSeverity } = require('./findings');
const { makeInputResolver, loadRepoConfig, matchPattern, globToRegex, filterDiff } = require('./collect');
const { defaultModelFor, reviewDiff, estimateCost, buildSystemPrompt, buildUserPrompt } = require('./review');
const { REVIEW_MARKER, isSherlockReview, findPreviousState, syncInlineComments, buildReviewBody, parseDiffForLinePositions, upsertStickyComment, createCheckRunSafely, isScenarioPreviouslyChecked } = require('./publish');
const { callAnthropic } = require('./providers/anthropic');
const { callBedrock } = require('./providers/bedrock');
const { callOllama } = require('./providers/ollama');

async function run() {
  try {
    // Load .sherlockqa.yml from the workspace if present. Action inputs always win.
    const repoConfig = loadRepoConfig();
    const getInput = makeInputResolver(repoConfig);

    const githubToken = core.getInput('github-token', { required: true });
    const aiProvider = getInput('ai-provider') || 'openai';
    const model = getInput('model') || defaultModelFor(aiProvider);
    const minSeverity = getInput('min-severity') || 'warning';
    let maxComments = parseInt(getInput('max-comments') || '5', 10);
    if (Number.isNaN(maxComments) || maxComments < 0) {
      core.warning('Invalid max-comments input; falling back to default (5).');
      maxComments = 5;
    }
    let minConfidence = parseFloat(getInput('min-confidence') || '0.6');
    if (Number.isNaN(minConfidence) || minConfidence < 0 || minConfidence > 1) {
      core.warning('Invalid min-confidence input; falling back to default (0.6).');
      minConfidence = 0.6;
    }
    const ignorePatterns = (getInput('ignore-patterns') || '*.md,*.txt,package-lock.json,yarn.lock')
      .split(',').map(p => p.trim()).filter(Boolean);
    const persona = getInput('persona') || '';
    const domainKnowledge = getInput('domain-knowledge') || '';
    const maxTokens = parseInt(getInput('max-tokens') || '4096', 10);
    const autoApprove = getInput('auto-approve') === 'true';
    const codeQuality = getInput('code-quality') === 'true';
    const reviewStyle = getInput('review-style') || 'compact';
    const useEmoji = getInput('use-emoji') !== 'false';
    const personality = getInput('personality') || 'detective';
    const reviewStrictness = getInput('review-strictness') || 'balanced';
    const mode = getInput('mode') || 'general';
    const updateSummaryComment = (getInput('update-summary-comment') || 'true') !== 'false';
    const createCheckRun = (getInput('create-check-run') || 'true') !== 'false';

    const context = github.context;
    if (context.eventName !== 'pull_request' && context.eventName !== 'pull_request_target') {
      core.setFailed('This action only works on pull_request / pull_request_target events');
      return;
    }

    const octokit = github.getOctokit(githubToken);
    const { owner, repo } = context.repo;
    const prNumber = context.payload.pull_request.number;
    const prAuthor = context.payload.pull_request.user.login;
    const commitSha = context.payload.pull_request.head.sha;

    core.info(`Reviewing PR #${prNumber} by @${prAuthor} (provider=${aiProvider}, model=${model}, mode=${mode})`);

    const previousCheckedScenarios = await findPreviousState(octokit, owner, repo, prNumber);

    const { data: diff } = await octokit.rest.pulls.get({
      owner, repo, pull_number: prNumber,
      mediaType: { format: 'diff' }
    });

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner, repo, pull_number: prNumber
    });

    const filesToReview = files.filter(file =>
      !ignorePatterns.some(pattern => matchPattern(file.filename, pattern))
    );

    if (filesToReview.length === 0) {
      core.info('No files to review after filtering');
      return;
    }

    const filteredDiff = filterDiff(diff, ignorePatterns);
    if (!filteredDiff) {
      core.info('No files to review after filtering');
      return;
    }

    core.info(`Reviewing ${filesToReview.length} files`);

    const { review, usage, truncated, responseTruncated, failedFiles } = await reviewDiff({
      diff: filteredDiff, files: filesToReview,
      config: {
        provider: aiProvider, model, prAuthor, persona, domainKnowledge, maxTokens,
        codeQuality, personality, strictness: reviewStrictness, mode, maxComments
      }
    });

    const cost = estimateCost(model, usage);
    const costStr = cost != null ? ` · ~$${cost.toFixed(4)}` : '';
    core.info(`Verdict: ${review.verdict} · ${review.line_comments?.length || 0} issues · ${usage.input}+${usage.output} tokens${costStr}`);

    // Noise budget: confidence filter + severity floor + suggestion routing + cap.
    const rawFindingsCount = (review.line_comments || []).length;
    const routed = filterAndRouteComments(review.line_comments || [], {
      minConfidence, minSeverity, maxComments
    });
    review.line_comments = routed.inline; // downstream counts/annotations = what we post

    if (rawFindingsCount > 0 && routed.inline.length === 0 && routed.minorNotes.length === 0 && review.verdict !== 'approved') {
      core.warning(`All ${rawFindingsCount} findings were filtered out (confidence/severity thresholds) but the verdict is ${review.verdict} — the summary may lack supporting detail.`);
    }

    const linePositionMap = parseDiffForLinePositions(diff);
    const reviewComments = [];
    for (const comment of routed.inline) {
      const filePositions = linePositionMap[comment.file] || {};
      const position = filePositions[String(comment.line)];
      if (position) {
        const emoji = SEVERITY_EMOJI[comment.severity] || '🔵';
        reviewComments.push({
          path: comment.file,
          position,
          body: `${emoji} **${comment.severity.toUpperCase()}**: ${comment.comment}`
        });
      }
    }

    const severityCounts = countSeverity(routed.inline);
    const body = buildReviewBody(review, prAuthor, previousCheckedScenarios, reviewStyle, useEmoji, truncated, severityCounts, responseTruncated, routed.minorNotes, failedFiles);

    if (autoApprove && review.verdict === 'approved' && context.eventName !== 'pull_request') {
      core.warning('auto-approve is disabled outside same-repo pull_request events (e.g. pull_request_target): the fork diff is untrusted and could steer the verdict via prompt injection. Posting a COMMENT instead.');
    }
    const event = resolveReviewEvent(review.verdict, autoApprove, context.eventName);

    // Inline findings are managed as individual comments (replaced each run) so
    // they never stack up. A formal review is submitted ONLY for the dismissable,
    // terminal verdicts (APPROVE / REQUEST_CHANGES) — the common "needs changes"
    // COMMENTED review is what used to pile up unremovably, so it's gone.
    const inlinePosted = await syncInlineComments(octokit, owner, repo, prNumber, commitSha, reviewComments);
    core.info(`Inline comments: ${inlinePosted} posted`);

    const plan = planFormalReview(event, updateSummaryComment, body);
    if (plan) {
      try {
        await octokit.rest.pulls.createReview({
          owner, repo, pull_number: prNumber,
          commit_id: commitSha, body: plan.body, event: plan.event
        });
        core.info(`Review submitted (event=${plan.event})`);
      } catch (e) {
        core.warning(`createReview failed (event=${plan.event}): ${e.message}`);
        if (plan.event === 'APPROVE') {
          core.warning('APPROVE not permitted by this token; the verdict is still visible in the summary. See the README "Enabling Auto-Approve" section.');
        }
        const fallback = planReviewFallback(plan, updateSummaryComment);
        if (fallback) {
          try {
            await octokit.rest.pulls.createReview({
              owner, repo, pull_number: prNumber,
              commit_id: commitSha, body: fallback.body, event: fallback.event
            });
            core.info('Fell back to a COMMENT review so the summary is not lost.');
          } catch (e2) {
            core.warning(`COMMENT fallback also failed: ${e2.message}`);
          }
        }
      }
    }

    if (updateSummaryComment) {
      await upsertStickyComment(octokit, owner, repo, prNumber, body);
    }

    if (createCheckRun) {
      await createCheckRunSafely({
        octokit, owner, repo, commitSha, review, severityCounts,
        reviewComments, usage, cost, model, aiProvider, truncated, responseTruncated
      });
    }

    core.setOutput('verdict', review.verdict);
    core.setOutput('summary', review.summary);
    core.setOutput('issues-count', review.line_comments?.length || 0);
    core.setOutput('tokens-in', String(usage.input));
    core.setOutput('tokens-out', String(usage.output));
    if (cost != null) core.setOutput('cost-usd', cost.toFixed(6));

    if (review.verdict === 'do_not_merge') {
      core.setFailed('Review verdict: Do Not Merge');
    }
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

// Decide which review event to submit. Auto-APPROVE is only ever allowed on
// same-repo `pull_request` events: on `pull_request_target` the diff comes from
// an untrusted fork and could steer the verdict via prompt injection, so an
// approved verdict there degrades to a plain COMMENT.
function resolveReviewEvent(verdict, autoApprove, eventName) {
  if (verdict === 'approved' && autoApprove && eventName === 'pull_request') return 'APPROVE';
  if (verdict === 'do_not_merge') return 'REQUEST_CHANGES';
  return 'COMMENT';
}

// Decide whether to submit a formal PR review, and with what body. Returns null
// when none should be posted — critically, the COMMENT verdict with the sticky
// comment enabled posts NO review (COMMENTED reviews can't be dismissed and would
// stack on every push). Only the dismissable terminal events, or the sticky-off
// fallback, produce a review.
function planFormalReview(event, updateSummaryComment, body) {
  if (event === 'APPROVE' || event === 'REQUEST_CHANGES') {
    const badge = event === 'APPROVE'
      ? '✅ **SherlockQA approved this PR.**'
      : '❌ **SherlockQA requested changes.**';
    return {
      event,
      body: updateSummaryComment
        ? `${REVIEW_MARKER}\n${badge}\n\nSee the SherlockQA summary comment for details.`
        : `${REVIEW_MARKER}\n${body}`
    };
  }
  if (!updateSummaryComment) {
    return { event: 'COMMENT', body: `${REVIEW_MARKER}\n${body}` };
  }
  return null;
}

// After a formal review submission fails (e.g. 422 "GitHub Actions is not
// permitted to approve pull requests"), decide the degraded retry (#6). With
// the sticky summary disabled the body would otherwise be lost, so fall back
// to a plain COMMENT review. With the sticky ON, the summary is already
// posted there — a COMMENT review would just re-create the undismissable
// pile-up (#21), so no retry.
function planReviewFallback(plan, updateSummaryComment) {
  if (updateSummaryComment || plan.event === 'COMMENT') return null;
  return { event: 'COMMENT', body: plan.body };
}

// Execute only when run directly (node dist/index.js). When required by the test
// suite the pure helpers are exposed instead, so importing never runs the action.
if (require.main === module) {
  run();
}

module.exports = {
  makeInputResolver,
  normalizeSeverity,
  normalizeConfidence,
  filterAndRouteComments,
  resolveReviewEvent,
  planFormalReview,
  planReviewFallback,
  parseReviewResponse,
  parseDiffForLinePositions,
  countSeverity,
  estimateCost,
  matchPattern,
  globToRegex,
  isScenarioPreviouslyChecked,
  isSherlockReview,
  buildSystemPrompt,
  buildUserPrompt,
  buildReviewBody,
  reviewDiff,
  callAnthropic,
  callOllama,
  callBedrock,
  defaultModelFor,
};
