function text(value = '') {
  return String(value || '').trim();
}

function array(value = []) {
  return Array.isArray(value) ? value : [];
}

function normalizeStatus(value = '') {
  const normalized = text(value).toLowerCase();
  if (!normalized) return '';
  if (['present', 'yes', 'reported', 'complete'].includes(normalized)) return 'present';
  if (['warning', 'partial', 'unclear', 'maybe', 'needs-review'].includes(normalized)) return 'warning';
  if (['absent', 'no', 'missing'].includes(normalized)) return 'absent';
  if (['optional', 'encouraged'].includes(normalized)) return 'optional';
  if (normalized === 'skipped') return 'skipped';
  if (['n/a', 'na', 'not applicable'].includes(normalized)) return 'na';
  if (['pending', 'running'].includes(normalized)) return 'pending';
  return normalized;
}

function summary(results = []) {
  return array(results).reduce((acc, item) => {
    const status = normalizeStatus(item.status);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, { present: 0, warning: 0, absent: 0, optional: 0, skipped: 0, na: 0, pending: 0 });
}

function guideStatus(totals = {}) {
  if (Number(totals.absent || 0) > 0) return 'absent';
  if (Number(totals.warning || 0) > 0) return 'warning';
  if (Number(totals.pending || 0) > 0) return 'pending';
  return 'present';
}

function guideById(guides = []) {
  return new Map(array(guides).map((guide) => [text(guide.id), guide]));
}

function resultById(results = []) {
  return new Map(array(results).map((item) => [text(item.id || item.itemId), item]));
}

function normalizeEvidenceQuotes(item = {}, fallback = {}) {
  const entries = array(item.evidenceQuotes).length
    ? array(item.evidenceQuotes)
    : (text(item.evidenceQuote || item.quote || item.anchorQuote)
      ? [{ quote: item.evidenceQuote || item.quote || item.anchorQuote, sourceBlockKey: item.sourceBlockKey }]
      : []);
  return entries
    .map((entry) => ({
      quote: text(entry.quote || entry.evidenceQuote || entry.anchorQuote),
      sourceBlockKey: text(entry.sourceBlockKey || fallback.sourceBlockKey)
    }))
    .filter((entry) => entry.quote || entry.sourceBlockKey);
}

export function buildEssentialGuidelineEvaluationRequest(annotation = {}, guides = []) {
  return {
    documentAnnotation: annotation || {},
    guides: array(guides).map((guide) => ({
      id: text(guide.id),
      name: text(guide.name),
      description: text(guide.description),
      sourceLabel: text(guide.sourceLabel) || 'EASE Essential guidelines',
      items: array(guide.items).map((item) => ({
        id: text(item.id),
        label: text(item.label || item.id),
        requirement: text(item.requirement),
        optional: Boolean(item.optional)
      })).filter((item) => item.id && item.label)
    })).filter((guide) => guide.id && guide.name && guide.items.length)
  };
}

export function pendingEssentialGuides(guides = [], message = 'Waiting for LLM guideline evaluation.') {
  return array(guides).map((guide) => {
    const results = array(guide.items).map((item) => ({
      ...item,
      status: 'pending',
      evidenceQuote: '',
      evidenceQuotes: [],
      sourceBlockKey: '',
      message
    }));
    return {
      ...guide,
      status: 'pending',
      summary: summary(results),
      results
    };
  });
}

export function normalizeEssentialGuidelineResults(value = {}, guides = []) {
  const sourceGuides = guideById(guides);
  const evaluatedGuides = array(value.guides);
  return array(guides).map((guide) => {
    const evaluated = evaluatedGuides.find((item) => text(item.id) === text(guide.id)) || {};
    const evaluatedResults = resultById(evaluated.results);
    const results = array(guide.items).map((item) => {
      const evaluatedItem = evaluatedResults.get(text(item.id)) || {};
      const status = normalizeStatus(evaluatedItem.status) || (item.optional ? 'optional' : 'warning');
      const sourceBlockKey = text(evaluatedItem.sourceBlockKey);
      const evidenceQuotes = normalizeEvidenceQuotes(evaluatedItem, { sourceBlockKey });
      return {
        ...item,
        status,
        evidenceQuote: evidenceQuotes[0]?.quote || text(evaluatedItem.evidenceQuote),
        evidenceQuotes,
        sourceBlockKey: sourceBlockKey || evidenceQuotes.find((entry) => entry.sourceBlockKey)?.sourceBlockKey || '',
        message: text(evaluatedItem.message || evaluatedItem.rationale || evaluatedItem.comment)
      };
    });
    const totals = summary(results);
    const sourceGuide = sourceGuides.get(text(guide.id)) || guide;
    return {
      ...sourceGuide,
      name: text(evaluated.name) || text(sourceGuide.name),
      description: text(sourceGuide.description),
      sourceLabel: text(sourceGuide.sourceLabel) || 'EASE Essential guidelines',
      status: normalizeStatus(evaluated.status) || guideStatus(totals),
      summary: totals,
      results
    };
  });
}
