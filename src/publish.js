const core = require('@actions/core');
const { SEVERITY_EMOJI, normalizeSeverity } = require('./findings');

// Hidden markers used to recognize SherlockQA's own output so it can be updated
// or replaced in place (independent of the use-emoji heading).
const STICKY_MARKER = '<!-- sherlockqa:sticky -->';
const REVIEW_MARKER = '<!-- sherlockqa:review -->';
const COMMENT_MARKER = '<!-- sherlockqa:comment -->';

// Matches SherlockQA's own review/comment output regardless of the use-emoji
// setting: the heading is "## 🔍 SherlockQA's Review" or "## [SHERLOCK] SherlockQA's
// Review", and newer output also carries a hidden REVIEW_MARKER.
function isSherlockReview(body) {
  if (!body) return false;
  return body.includes(REVIEW_MARKER) || body.includes("SherlockQA's Review");
}

// Read previously-checked QA scenarios (from the sticky comment and any prior
// reviews) and dismiss stale *dismissable* SherlockQA reviews. COMMENTED reviews
// cannot be dismissed via the API, so we no longer post the summary as one — see
// the posting logic in run().
async function findPreviousState(octokit, owner, repo, prNumber) {
  const checkedScenarios = new Set();
  const harvest = (body) => {
    for (const m of (body || '').matchAll(/- \[x\] (.+)/gi)) checkedScenarios.add(m[1].trim());
  };

  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100
    });
    for (const c of comments) {
      if (c.body && (c.body.includes(STICKY_MARKER) || isSherlockReview(c.body))) harvest(c.body);
    }
  } catch (e) {
    core.warning(`Failed to read previous comments: ${e.message}`);
  }

  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner, repo, pull_number: prNumber, per_page: 100
    });
    for (const review of reviews) {
      if (!isSherlockReview(review.body)) continue;
      harvest(review.body);
      // Only APPROVED / CHANGES_REQUESTED reviews are dismissable; COMMENTED are not.
      if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
        try {
          await octokit.rest.pulls.dismissReview({
            owner, repo, pull_number: prNumber, review_id: review.id,
            message: '🔄 Superseded by an updated SherlockQA review.'
          });
          core.info(`Dismissed previous review #${review.id}`);
        } catch (e) {
          core.info(`Could not dismiss review #${review.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    core.warning(`Failed to check previous reviews: ${e.message}`);
  }

  return checkedScenarios;
}

// Replace SherlockQA's inline findings in place: delete the ones it left last run
// (tagged with COMMENT_MARKER), then post the current set as individual review
// comments. This avoids stacking a new COMMENTED review on every push.
async function syncInlineComments(octokit, owner, repo, prNumber, commitSha, comments) {
  try {
    const existing = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
      owner, repo, pull_number: prNumber, per_page: 100
    });
    for (const c of existing) {
      if (c.body && c.body.includes(COMMENT_MARKER)) {
        try {
          await octokit.rest.pulls.deleteReviewComment({ owner, repo, comment_id: c.id });
        } catch (e) {
          core.info(`Could not delete stale comment #${c.id}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    core.warning(`Failed to list existing review comments: ${e.message}`);
  }

  let posted = 0;
  for (const c of comments) {
    try {
      await octokit.rest.pulls.createReviewComment({
        owner, repo, pull_number: prNumber, commit_id: commitSha,
        path: c.path, position: c.position,
        body: `${c.body}\n${COMMENT_MARKER}`
      });
      posted++;
    } catch (e) {
      core.info(`Could not post inline comment on ${c.path}: ${e.message}`);
    }
  }
  return posted;
}

function formatSeverityBreakdown(counts, useEmoji) {
  const parts = [];
  const errIcon = useEmoji ? '🔴' : 'E';
  const warnIcon = useEmoji ? '🟡' : 'W';
  const suggIcon = useEmoji ? '🔵' : 'S';
  if (counts.error) parts.push(`${counts.error} ${errIcon}`);
  if (counts.warning) parts.push(`${counts.warning} ${warnIcon}`);
  if (counts.suggestion) parts.push(`${counts.suggestion} ${suggIcon}`);
  return parts.join(' · ');
}

// Renders the collapsed "Minor notes" block. Entries are usually suggestion-
// severity nits ("no action required"), but overflow from the max-comments
// cap can push error/warning findings in here too (I4) — those must not be
// mislabeled as harmless, so the header drops the "no action required" claim
// and each entry carries its real severity emoji.
function formatMinorNotesBlock(minorNotes, e) {
  const hasOverBudget = minorNotes.some(n => normalizeSeverity(n.severity) !== 'suggestion');
  const headerSuffix = hasOverBudget
    ? ` — includes ${minorNotes.filter(n => normalizeSeverity(n.severity) !== 'suggestion').length} over-budget findings`
    : ' — low-severity, no action required';
  const lines = ['<details>'];
  lines.push(`<summary>${e.quality} <b>Minor notes (${minorNotes.length})</b>${headerSuffix}</summary>\n`);
  minorNotes.forEach(n => {
    const emoji = SEVERITY_EMOJI[normalizeSeverity(n.severity)] || '🔵';
    lines.push(`- ${emoji} \`${n.file}:${n.line}\` — ${n.comment}`);
  });
  lines.push('\n</details>\n');
  return lines;
}

function buildReviewBody(review, prAuthor, previousCheckedScenarios = new Set(), reviewStyle = 'compact', useEmoji = true, truncated = false, severityCounts = null, responseTruncated = false, minorNotes = [], failedFiles = []) {
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

  const issueCount = review.line_comments?.length || 0;
  const qaCount = review.qa_scenarios?.length || 0;
  const questionCount = review.questions?.length || 0;
  const severityStr = severityCounts && issueCount > 0
    ? ` (${formatSeverityBreakdown(severityCounts, useEmoji)})`
    : '';
  const minorNotesStr = minorNotes.length > 0 ? ` · +${minorNotes.length} minor note${minorNotes.length === 1 ? '' : 's'}` : '';
  const failedFilesBanner = `> ${e.warning} **Heads up:** the AI review failed for ${failedFiles.join(', ')} — these files were not reviewed.\n`;

  const parts = [];

  if (reviewStyle === 'compact') {
    const isApproved = review.verdict === 'approved';
    const isCleanApproval = isApproved && issueCount === 0 && questionCount === 0 && minorNotes.length === 0;
    // QA is suppressed on approvals below (M7) — don't advertise a count for a
    // section that never renders in this style.
    const qaStr = isApproved ? '' : ` · ${qaCount} QA scenarios`;
    parts.push(`## ${e.detective} SherlockQA's Review\n`);
    parts.push(`**Verdict:** ${verdictEmoji[review.verdict] || e.needs_changes} ${verdictText[review.verdict] || review.verdict} | ${issueCount} issues${severityStr}${minorNotesStr}${qaStr}${questionCount > 0 ? ` · ${questionCount} questions` : ''}\n`);
    if (review.verdict_reason) parts.push(`> ${review.verdict_reason}\n`);

    if (failedFiles.length > 0) {
      parts.push(failedFilesBanner);
    } else if (truncated) {
      parts.push(`> ${e.warning} **Heads up:** PR diff was large and got truncated — this review may have missed parts of the change. Consider splitting large PRs.\n`);
    }

    if (responseTruncated) {
      parts.push(`> ${e.warning} **Heads up:** the AI response hit the \`max-tokens\` limit and was cut off — findings may be missing and the verdict may be unreliable. Raise \`max-tokens\` in your workflow.\n`);
    }

    if (!isCleanApproval) {
      parts.push(`**Summary:** ${review.summary || 'No summary'}\n`);

      if (review.code_quality && review.code_quality !== 'null') {
        const qualityText = typeof review.code_quality === 'string'
          ? review.code_quality
          : review.code_quality.summary || '';
        if (qualityText && qualityText !== 'null') {
          parts.push(`**Code Quality:** ${qualityText}\n`);
        }
      }

      if (review.tests_required && review.test_suggestion) {
        parts.push('<details>');
        parts.push(`<summary>${e.tests} <b>Tests Suggested</b></summary>\n`);
        parts.push(`${review.test_suggestion}\n`);
        parts.push('</details>\n');
      }

      if (!isApproved && review.qa_scenarios?.length > 0) {
        parts.push('<details>');
        parts.push(`<summary>${e.qa} <b>QA Scenarios (${qaCount})</b></summary>\n`);
        review.qa_scenarios.forEach(scenario => {
          const isChecked = isScenarioPreviouslyChecked(scenario, previousCheckedScenarios);
          const checkbox = isChecked ? '[x]' : '[ ]';
          parts.push(`- ${checkbox} ${scenario}`);
        });
        parts.push('\n</details>\n');
      }

      if (!isApproved && review.questions?.length > 0) {
        parts.push(`**${e.questions} Questions:** ${review.questions.join(' | ')}\n`);
      }
    }

    if (minorNotes.length > 0) {
      parts.push(...formatMinorNotesBlock(minorNotes, e));
    }
  } else {
    parts.push(`## ${e.detective} SherlockQA's Review\n`);
    parts.push(`### ${e.summary} Summary\n${review.summary || 'No summary'}\n`);

    if (failedFiles.length > 0) {
      parts.push(failedFilesBanner);
    } else if (truncated) {
      parts.push(`> ${e.warning} **Heads up:** PR diff was large and got truncated — this review may have missed parts of the change.\n`);
    }

    if (responseTruncated) {
      parts.push(`> ${e.warning} **Heads up:** the AI response hit the \`max-tokens\` limit and was cut off — findings may be missing and the verdict may be unreliable. Raise \`max-tokens\` in your workflow.\n`);
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

    if (review.code_quality && review.code_quality !== 'null') {
      const qualityText = typeof review.code_quality === 'string'
        ? review.code_quality
        : review.code_quality.summary || '';
      if (qualityText && qualityText !== 'null') {
        parts.push(`### ${e.quality} Code Quality`);
        parts.push(`${qualityText}\n`);
      }
      if (typeof review.code_quality === 'object' && review.code_quality.issues?.length > 0) {
        review.code_quality.issues.forEach(issue => parts.push(`- ${issue}`));
        parts.push('');
      }
    }

    parts.push(`### ${e.verdict} Verdict\n${verdictEmoji[review.verdict] || e.needs_changes} ${verdictText[review.verdict] || review.verdict}${minorNotesStr}`);
    if (review.verdict_reason) parts.push(`\n> ${review.verdict_reason}`);

    if (minorNotes.length > 0) {
      parts.push(...formatMinorNotesBlock(minorNotes, e));
    }
  }

  return parts.join('\n');
}

function parseDiffForLinePositions(diffText) {
  const fileLineMap = {};
  let currentFile = null;
  let diffPosition = 0;
  let currentNewLine = 0;
  let inHunk = false;

  for (const line of diffText.split('\n')) {
    // Every file section starts with "diff --git". Leaving the previous file
    // here guarantees its header lines (index, --- a/, +++ b/) can never be
    // recorded as the previous file's trailing positions (#7).
    if (line.startsWith('diff --git ')) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    if (!currentFile) {
      // Only "+++ b/<path>" opens an addressable file. "+++ /dev/null"
      // (deleted file) has no new side, so its hunks stay unaddressable.
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
        fileLineMap[currentFile] = {};
        diffPosition = 0; // GitHub positions count per file, from its first @@
      }
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10);
      diffPosition++;
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    // Inside a hunk, +/- prefixes always mean content — a real next-file
    // "+++ b/" can't appear here because "diff --git" resets inHunk first.
    if (line.startsWith('+')) {
      fileLineMap[currentFile][currentNewLine] = diffPosition;
      currentNewLine++;
      diffPosition++;
    } else if (line.startsWith('-')) {
      diffPosition++;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" occupies a diff line — it counts toward
      // position but maps to no new-side line.
      diffPosition++;
    } else {
      fileLineMap[currentFile][currentNewLine] = diffPosition;
      currentNewLine++;
      diffPosition++;
    }
  }
  return fileLineMap;
}

async function upsertStickyComment(octokit, owner, repo, prNumber, body) {
  const stickyBody = `${STICKY_MARKER}\n${body}`;
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100
    });
    const existing = comments.find(c => c.body && c.body.includes(STICKY_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({
        owner, repo, comment_id: existing.id, body: stickyBody
      });
      core.info(`Updated sticky comment #${existing.id}`);
    } else {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: prNumber, body: stickyBody
      });
      core.info('Created sticky comment');
    }
  } catch (e) {
    core.warning(`Failed to upsert sticky comment: ${e.message}`);
  }
}

async function createCheckRunSafely(opts) {
  const { octokit, owner, repo, commitSha, review, severityCounts,
    usage, cost, model, aiProvider, truncated, responseTruncated } = opts;

  const conclusion =
    review.verdict === 'do_not_merge' ? 'failure' :
    review.verdict === 'needs_changes' ? 'neutral' :
    review.verdict === 'approved' ? 'success' : 'neutral';

  const titleByVerdict = {
    approved: 'Approved — no blocking issues',
    needs_changes: 'Needs changes',
    do_not_merge: 'Do not merge'
  };

  const issueCount = (review.line_comments || []).length;
  const summaryLines = [
    `**Verdict:** ${review.verdict}`,
    `**Issues:** ${issueCount} (${severityCounts.error}🔴 · ${severityCounts.warning}🟡 · ${severityCounts.suggestion}🔵)`,
    `**Model:** ${aiProvider} / ${model}`,
    `**Tokens:** ${usage.input} in / ${usage.output} out${cost != null ? ` · ~$${cost.toFixed(4)}` : ''}`
  ];
  if (truncated) summaryLines.push('> ⚠️ PR diff truncated — review may be incomplete.');
  if (responseTruncated) summaryLines.push('> ⚠️ AI response hit max-tokens — review may be incomplete.');
  if (review.summary) summaryLines.push('', review.summary);
  if (review.verdict_reason) summaryLines.push('', `> ${review.verdict_reason}`);

  // Map review comments back to annotations (file + line). The review API uses
  // diff "position" for inline comments, but the Checks API needs file path + line.
  const annotations = [];
  for (const c of (review.line_comments || [])) {
    if (!c.file || !c.line) continue;
    const level = c.severity === 'error' ? 'failure'
      : c.severity === 'warning' ? 'warning' : 'notice';
    annotations.push({
      path: c.file,
      start_line: c.line,
      end_line: c.line,
      annotation_level: level,
      message: c.comment || ''
    });
    if (annotations.length >= 50) break; // Checks API limit per request
  }

  try {
    await octokit.rest.checks.create({
      owner, repo,
      name: 'SherlockQA',
      head_sha: commitSha,
      status: 'completed',
      conclusion,
      output: {
        title: titleByVerdict[review.verdict] || 'Reviewed',
        summary: summaryLines.join('\n'),
        annotations
      }
    });
    core.info(`Check Run created (conclusion=${conclusion})`);
  } catch (e) {
    // Most common cause: workflow lacks checks:write permission. Don't fail the action.
    core.warning(`Check Run skipped: ${e.message}. Add "checks: write" to workflow permissions to enable.`);
  }
}

function isScenarioPreviouslyChecked(scenario, previousCheckedScenarios) {
  const normalize = (text) => text.toLowerCase().replace(/[^\w\s]/g, '').trim();
  const normalizedScenario = normalize(scenario);
  for (const checked of previousCheckedScenarios) {
    const normalizedChecked = normalize(checked);
    if (normalizedScenario === normalizedChecked) return true;
    // Fuzzy carryover only for near-identical scenarios: ≥90% of the smaller
    // word set shared AND at least 4 words in common. A one-word action change
    // ("upload" → "delete") must NOT inherit the checkmark (#11), so the old
    // bare-substring rule and 0.7 threshold are gone. False negatives are the
    // safe direction — worst case QA re-tests a scenario.
    const scenarioWords = new Set(normalizedScenario.split(/\s+/).filter(Boolean));
    const checkedWords = new Set(normalizedChecked.split(/\s+/).filter(Boolean));
    const intersection = [...scenarioWords].filter(w => checkedWords.has(w));
    const minSize = Math.min(scenarioWords.size, checkedWords.size);
    if (minSize > 0 && intersection.length >= 4 && intersection.length / minSize >= 0.9) return true;
  }
  return false;
}

module.exports = {
  STICKY_MARKER,
  REVIEW_MARKER,
  COMMENT_MARKER,
  isSherlockReview,
  findPreviousState,
  syncInlineComments,
  formatSeverityBreakdown,
  formatMinorNotesBlock,
  buildReviewBody,
  parseDiffForLinePositions,
  upsertStickyComment,
  createCheckRunSafely,
  isScenarioPreviouslyChecked,
};
