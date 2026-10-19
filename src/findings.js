const core = require('@actions/core');

const SEVERITY_LEVEL = { suggestion: 1, warning: 2, error: 3 };
const SEVERITY_EMOJI = { error: '🔴', warning: '🟡', suggestion: '🔵' };

// Normalize any model-supplied severity to a known tier. Missing or unknown
// values (e.g. 'critical', 'info', 'nit', undefined) collapse to 'suggestion'
// so they can never bypass the min-severity filter or crash on .toUpperCase().
function normalizeSeverity(sev) {
  const lower = String(sev || '').toLowerCase();
  return SEVERITY_LEVEL[lower] ? lower : 'suggestion';
}

// Model-supplied confidence (0-1) for a finding. Missing or unparseable values
// collapse to 0.5 so old-format responses and weaker models neither crash nor
// sail past the min-confidence filter with implicit certainty.
function normalizeConfidence(value) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

// Noise budget: drop low-confidence and below-min-severity findings, route
// suggestion-severity findings to a consolidated "minor notes" block instead
// of inline comments, and cap inline comments at maxComments (0 = unlimited),
// ranked by severity then confidence. Overflow joins the minor notes.
function filterAndRouteComments(comments, { minConfidence, minSeverity, maxComments }) {
  const minLevel = SEVERITY_LEVEL[minSeverity] || 1;
  const surviving = (comments || [])
    .map(c => {
      const hasConfidence = !(c.confidence === undefined || c.confidence === null || c.confidence === '' || Number.isNaN(Number(c.confidence)));
      return { ...c, severity: normalizeSeverity(c.severity), confidence: normalizeConfidence(c.confidence), hasConfidence };
    })
    // Missing/invalid confidence bypasses the min-confidence filter (backward
    // compat: models that don't emit the field must not have every finding
    // dropped) — it still ranks at 0.5 via normalizeConfidence above.
    .filter(c => !c.hasConfidence || c.confidence >= minConfidence)
    .filter(c => SEVERITY_LEVEL[c.severity] >= minLevel)
    // eslint-disable-next-line no-unused-vars
    .map(({ hasConfidence, ...rest }) => rest);

  const minorNotes = surviving.filter(c => c.severity === 'suggestion');
  const inline = surviving
    .filter(c => c.severity !== 'suggestion')
    .sort((a, b) => (SEVERITY_LEVEL[b.severity] - SEVERITY_LEVEL[a.severity]) || (b.confidence - a.confidence));

  if (maxComments > 0 && inline.length > maxComments) {
    minorNotes.push(...inline.splice(maxComments));
  }
  return { inline, minorNotes };
}

function parseReviewResponse(content) {
  // Coerce first: a refusal / content-filter returns null content, and calling
  // .trim() on it would throw *outside* the try below (uncatchable) and fail the
  // whole action. An empty string simply flows into the safe fallback.
  const raw = content == null ? '' : String(content);
  let jsonContent = raw.trim();
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonMatch) jsonContent = jsonMatch[1];
  try {
    return JSON.parse(jsonContent);
  } catch (e) {
    // Best-effort: extract first {...} block
    const braceMatch = raw.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch (_) { /* fall through */ }
    }
    core.warning(`Failed to parse AI response: ${e.message}`);
    core.warning(`Raw response: ${raw.slice(0, 500)}`);
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

function countSeverity(comments) {
  const counts = { error: 0, warning: 0, suggestion: 0 };
  for (const c of comments) {
    counts[normalizeSeverity(c.severity)]++;
  }
  return counts;
}

module.exports = {
  SEVERITY_LEVEL,
  SEVERITY_EMOJI,
  normalizeSeverity,
  normalizeConfidence,
  filterAndRouteComments,
  parseReviewResponse,
  countSeverity,
};
