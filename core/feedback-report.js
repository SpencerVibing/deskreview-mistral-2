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
  }, { total: 0, present: 0, warning: 0, absent: 0, optional: 0, skipped: 0, na: 0, pending: 0 });
}

function guideResultItem(item = {}) {
  const evidenceQuotes = array(item.evidenceQuotes)
    .map((entry) => ({
      quote: text(entry.quote),
      sourceBlockKey: text(entry.sourceBlockKey || item.sourceBlockKey)
    }))
    .filter((entry) => entry.quote);
  const fallbackQuote = text(item.evidenceQuote);
  return {
    id: text(item.id),
    label: text(item.label || item.id),
    section: text(item.section),
    requirement: text(item.requirement),
    status: text(item.status),
    message: text(item.message),
    evidenceQuote: fallbackQuote || evidenceQuotes[0]?.quote || '',
    evidenceQuotes: evidenceQuotes.length
      ? evidenceQuotes
      : (fallbackQuote ? [{ quote: fallbackQuote, sourceBlockKey: text(item.sourceBlockKey) }] : []),
    sourceBlockKey: text(item.sourceBlockKey || evidenceQuotes[0]?.sourceBlockKey)
  };
}

function guideModel(guide = {}) {
  return {
    id: text(guide.id),
    name: text(guide.name),
    description: text(guide.description),
    sourceLabel: text(guide.sourceLabel),
    summary: summarizeStatuses(guide.results),
    results: array(guide.results).map(guideResultItem)
  };
}

export function buildFeedbackReportModel({
  essentialResults = [],
  reportingGuideResults = [],
  reportingMatches = null,
  annotation = null
} = {}) {
  const essentialGuides = array(essentialResults).map(guideModel);
  const reportingGuides = array(reportingGuideResults).map(guideModel);
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
  return { essentialGuides, reportingGuides, reportingMatches: matches, quoteAnchors };
}
