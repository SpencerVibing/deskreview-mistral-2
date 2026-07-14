function array(value = []) {
  return Array.isArray(value) ? value : [];
}

function text(value = '') {
  return String(value || '').trim();
}

export function summarizeStatuses(results = []) {
  return array(results).reduce((summary, item) => {
    const status = text(item.status) || 'warning';
    summary[status] = (summary[status] || 0) + 1;
    summary.total += 1;
    return summary;
  }, { total: 0, present: 0, warning: 0, absent: 0, na: 0 });
}

export function buildFeedbackReportModel({ essentialResults = [], reportingMatches = null, annotation = null } = {}) {
  const essentialGuides = array(essentialResults).map((guide) => ({
    id: text(guide.id),
    name: text(guide.name),
    summary: summarizeStatuses(guide.results),
    results: array(guide.results).map((item) => ({
      id: text(item.id),
      label: text(item.label || item.id),
      status: text(item.status),
      message: text(item.message),
      evidenceQuote: text(item.evidenceQuote),
      sourceBlockKey: text(item.sourceBlockKey)
    }))
  }));
  const matches = array(reportingMatches?.matches).map((match) => ({
    guidelineId: text(match.guidelineId),
    label: text(match.label),
    rationale: text(match.rationale),
    confidence: Number(match.confidence || 0),
    anchorQuote: text(match.anchorQuote),
    sourceBlockKey: text(match.sourceBlockKey)
  }));
  const quoteAnchors = array(annotation?.quoteAnchors).map((anchor) => ({
    kind: text(anchor.kind),
    label: text(anchor.label),
    quote: text(anchor.quote),
    sourceBlockKey: text(anchor.sourceBlockKey)
  })).filter((anchor) => anchor.quote);
  return { essentialGuides, reportingMatches: matches, quoteAnchors };
}
